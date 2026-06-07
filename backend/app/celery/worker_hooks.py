"""
Worker startup hooks: DB/Celery sync and GPU status (GPU worker only).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime

from celery.signals import worker_process_init

from app.celery._config import REDIS_URL

logger = logging.getLogger(__name__)

GPU_STATUS_REDIS_KEY = os.environ.get("LAI_GPU_STATUS_REDIS_KEY", "lai:worker_gpu_status")
GPU_STATUS_TTL_SECONDS = int(os.environ.get("LAI_GPU_STATUS_TTL_SECONDS", "300"))


def _run_nvidia_smi() -> list[dict]:
    candidates = []
    which_path = shutil.which("nvidia-smi")
    if which_path:
        candidates.append(which_path)
    candidates.extend(["nvidia-smi", "/usr/bin/nvidia-smi"])

    seen = set()
    for exe in candidates:
        if not exe or exe in seen:
            continue
        seen.add(exe)
        try:
            out = subprocess.run(
                [
                    exe,
                    "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if out.returncode != 0 or not out.stdout.strip():
                continue
            gpus = []
            for line in out.stdout.strip().split("\n"):
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 4:
                    continue
                try:
                    gpus.append(
                        {
                            "name": parts[0],
                            "memory_used_mb": int(float(parts[1] or 0)),
                            "memory_total_mb": int(float(parts[2] or 0)),
                            "utilization_percent": int(float(parts[3] or 0)),
                        }
                    )
                except ValueError:
                    continue
            if gpus:
                return gpus
        except Exception:
            continue
    return []


def collect_worker_gpu_status() -> dict:
    gpus = _run_nvidia_smi()
    total_used_mb = sum(g.get("memory_used_mb", 0) for g in gpus)
    total_mb = sum(g.get("memory_total_mb", 0) for g in gpus)
    return {
        "has_gpu": len(gpus) > 0,
        "gpu_count": len(gpus),
        "gpus": gpus,
        "memory_used_mb": total_used_mb,
        "memory_total_mb": total_mb,
        "source": "celery_worker_gpu",
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def publish_worker_gpu_status() -> None:
    try:
        import redis

        status = collect_worker_gpu_status()
        client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        client.setex(GPU_STATUS_REDIS_KEY, GPU_STATUS_TTL_SECONDS, json.dumps(status))
        logger.info(
            "Published worker GPU status to Redis key=%s has_gpu=%s count=%s",
            GPU_STATUS_REDIS_KEY,
            status.get("has_gpu"),
            status.get("gpu_count"),
        )
    except Exception as e:
        logger.warning("Failed to publish worker GPU status: %s", e)


def upsert_worker_gpu_status_db() -> None:
    try:
        from app.database import SessionLocal
        from app.models import WorkerGpuStatus

        status = collect_worker_gpu_status()
        db = SessionLocal()
        try:
            row = db.query(WorkerGpuStatus).filter(WorkerGpuStatus.id == 1).first()
            if row is None:
                row = WorkerGpuStatus(id=1)
                db.add(row)
            row.has_gpu = bool(status.get("has_gpu", False))
            row.gpu_count = int(status.get("gpu_count", 0) or 0)
            row.gpus = list(status.get("gpus", []))
            row.memory_used_mb = int(status.get("memory_used_mb", 0) or 0)
            row.memory_total_mb = int(status.get("memory_total_mb", 0) or 0)
            row.source = str(status.get("source", "celery_worker_gpu"))
            row.updated_at = datetime.utcnow()
            db.commit()
        finally:
            db.close()
    except Exception as e:
        logger.warning("Failed to persist worker GPU status to DB: %s", e)


def sync_tasks_with_database(celery_app) -> None:
    """Revoke Celery jobs for DB tasks that were stopped/cancelled/paused."""
    time.sleep(1)
    try:
        from app.models import Task
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        database_url = os.environ.get(
            "DATABASE_URL", "postgresql://postgres:postgres@db/lai_db"
        )
        engine = create_engine(database_url, pool_pre_ping=True)
        session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        db = session_local()

        logger.info("=== Worker startup: Syncing Celery tasks with database ===")
        try:
            stopped_tasks = db.query(Task).filter(
                Task.status.in_(["stopped", "cancelled", "paused"])
            ).all()
            for task in stopped_tasks:
                if task.task_metadata and isinstance(task.task_metadata, dict):
                    celery_task_id = task.task_metadata.get("celery_task_id")
                    if celery_task_id:
                        try:
                            celery_app.control.revoke(
                                celery_task_id, terminate=True, signal="SIGKILL"
                            )
                            celery_app.backend.delete(celery_task_id)
                            logger.info(
                                "Revoked Celery task %s (DB task %s status=%s)",
                                celery_task_id,
                                task.id,
                                task.status,
                            )
                        except Exception as e:
                            logger.warning(
                                "Failed to revoke Celery task %s: %s", celery_task_id, e
                            )
            logger.info(
                "=== Worker startup sync complete: Cleaned %s stopped/cancelled tasks ===",
                len(stopped_tasks),
            )
        finally:
            db.close()
    except Exception as e:
        logger.error("Error during worker startup task sync: %s", e, exc_info=True)


def register_general_worker_hooks(celery_app) -> None:
    @worker_process_init.connect
    def _on_general_worker_start(sender=None, **kwargs):
        sync_tasks_with_database(celery_app)


def register_gpu_worker_hooks(celery_app) -> None:
    @worker_process_init.connect
    def _on_gpu_worker_start(sender=None, **kwargs):
        try:
            from app.ml.numpy_compat import ensure_numpy_torch_compat

            ensure_numpy_torch_compat()
            sync_tasks_with_database(celery_app)
        finally:
            publish_worker_gpu_status()
            upsert_worker_gpu_status_db()
