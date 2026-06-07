"""
System resource endpoints (GPU availability and memory usage).

GPU is read on the backend (e.g. inside Docker). The backend runs in a single
environment (typically Linux in Docker), so client OS (Windows/Linux/macOS)
does not matter — the navbar always shows whatever GPU the backend container sees.
"""
import logging
import json
import os
import shutil
import subprocess
from typing import Any, List

from fastapi import APIRouter
from sqlalchemy.orm import Session
from celery.exceptions import TimeoutError as CeleryTimeoutError

from ..database import SessionLocal
from ..models import WorkerGpuStatus
from ..celery_app import celery_app

router = APIRouter()
logger = logging.getLogger(__name__)
REDIS_URL = os.environ.get('REDIS_URL', 'redis://redis:6379/0')
GPU_STATUS_REDIS_KEY = os.environ.get('LAI_GPU_STATUS_REDIS_KEY', 'lai:worker_gpu_status')
GPU_STATUS_MAX_AGE_SECONDS = int(os.environ.get('LAI_GPU_STATUS_MAX_AGE_SECONDS', '180'))
GPU_REFRESH_ON_REQUEST = os.environ.get('LAI_GPU_REFRESH_ON_REQUEST', '1') not in ('0', 'false', 'False')
GPU_REFRESH_TIMEOUT_SECONDS = float(os.environ.get('LAI_GPU_REFRESH_TIMEOUT_SECONDS', '2.0'))


def _read_worker_gpu_status_db() -> dict[str, Any] | None:
    """Read latest worker GPU status sample from DB if it's fresh."""
    db: Session = SessionLocal()
    try:
        row = db.query(WorkerGpuStatus).filter(WorkerGpuStatus.id == 1).first()
        if not row:
            return None
        age_s = None
        if row.updated_at is not None:
            from datetime import datetime, timezone
            age_s = (datetime.utcnow() - row.updated_at.replace(tzinfo=None)).total_seconds()
            if age_s > GPU_STATUS_MAX_AGE_SECONDS:
                return None
        return {
            'has_gpu': bool(row.has_gpu),
            'gpu_count': int(row.gpu_count or 0),
            'gpus': list(row.gpus or []),
            'memory_used_mb': int(row.memory_used_mb or 0),
            'memory_total_mb': int(row.memory_total_mb or 0),
            'source': row.source or 'celery_worker_db',
            'updated_at': row.updated_at.isoformat() + 'Z' if row.updated_at else None,
            'age_seconds': int(age_s) if age_s is not None else None,
        }
    except Exception as e:
        logger.debug('worker gpu status db read failed: %s', e)
    finally:
        db.close()
    return None


def _read_worker_gpu_status() -> dict[str, Any] | None:
    """Read latest worker-published GPU status from Redis."""
    try:
        import redis

        client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        raw = client.get(GPU_STATUS_REDIS_KEY)
        if not raw:
            return None
        payload = json.loads(raw)
        if isinstance(payload, dict) and isinstance(payload.get('has_gpu'), bool):
            return payload
    except Exception as e:
        logger.debug('worker gpu status cache read failed: %s', e)
    return None


def _trigger_worker_gpu_refresh() -> None:
    """Request a fresh GPU sample from worker-gpu with a short timeout."""
    try:
        from app.ml.celery_dispatch import GPU_QUEUE, send_gpu_task

        async_result = send_gpu_task(
            "app.tasks.task_monitoring.refresh_worker_gpu_status",
            queue=GPU_QUEUE,
        )
        async_result.get(timeout=GPU_REFRESH_TIMEOUT_SECONDS)
    except CeleryTimeoutError:
        logger.debug("worker gpu refresh request timed out")
    except Exception as e:
        logger.debug("worker gpu refresh request failed: %s", e)


def _run_nvidia_smi(exe: str) -> List[dict[str, Any]]:
    """Run nvidia-smi with given executable path; return list of GPU dicts or empty."""
    try:
        out = subprocess.run(
            [
                exe,
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0 or not out.stdout.strip():
            if out.stderr:
                logger.debug("nvidia-smi %s: returncode=%s stderr=%s", exe, out.returncode, out.stderr[:200])
            return []
        gpus = []
        for line in out.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                try:
                    name = parts[0]
                    mem_used = int(float(parts[1].replace("MiB", "").strip() or 0))
                    mem_total = int(float(parts[2].replace("MiB", "").strip() or 0))
                    util = int(float(parts[3].replace("%", "").strip() or 0))
                    gpus.append({
                        "name": name,
                        "memory_used_mb": mem_used,
                        "memory_total_mb": mem_total,
                        "utilization_percent": min(100, max(0, util)),
                    })
                except (ValueError, IndexError):
                    continue
        return gpus
    except FileNotFoundError:
        return []
    except subprocess.TimeoutExpired:
        return []
    except Exception as e:
        logger.debug("nvidia-smi %s failed: %s", exe, e)
        return []


def _query_gpu_nvidia_smi() -> tuple[List[dict[str, Any]], list[str]]:
    """Query GPU info via nvidia-smi. Returns (gpus, debug_messages)."""
    debug: list[str] = []
    # Try: which('nvidia-smi'), then explicit paths (toolkit mounts at host path, often /usr/bin)
    candidates: list[str] = []
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
            gpus = _run_nvidia_smi(exe)
            if gpus:
                logger.info("GPU detected via %s: %d device(s)", exe, len(gpus))
                return gpus, debug
        except Exception as e:
            debug.append(f"{exe}: {e}")
    debug.append(
        "nvidia-smi not found or failed. In Docker: ensure backend has runtime: nvidia and "
        "deploy.reservations.devices (nvidia). On host: install nvidia-container-toolkit and run: docker compose up -d --force-recreate backend"
    )
    logger.info("No GPU from nvidia-smi. %s", debug[-1])
    return [], debug


def _query_gpu_torch() -> List[dict[str, Any]]:
    """Query GPU info via PyTorch if available."""
    try:
        import torch
        if not torch.cuda.is_available():
            return []
        gpus = []
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            total_mb = props.total_memory // (1024 * 1024)
            # Allocated by current process (may be 0 in API process)
            try:
                used_mb = torch.cuda.memory_allocated(i) // (1024 * 1024)
            except Exception:
                used_mb = 0
            gpus.append({
                "name": props.name,
                "memory_used_mb": used_mb,
                "memory_total_mb": total_mb,
                "utilization_percent": 0,  # torch doesn't give utilization
            })
        logger.info("GPU detected via PyTorch CUDA: %d device(s)", len(gpus))
        return gpus
    except ImportError:
        return []
    except Exception as e:
        logger.debug("torch cuda query failed: %s", e)
        return []


def _gpu_tier_configured() -> bool:
    raw = os.environ.get("LAI_GPU_TIER", "").strip().lower()
    profiles = os.environ.get("COMPOSE_PROFILES", "").strip().lower()
    return raw in ("1", "true", "yes") or "gpu" in profiles.split(",")


def _enrich_gpu_payload(payload: dict[str, Any]) -> dict[str, Any]:
    tier = _gpu_tier_configured()
    payload["gpu_tier_configured"] = tier
    if not tier:
        payload["gpu_features_message"] = (
            "GPU tier is disabled. Run lai install, enable the GPU tier, then lai pull && lai up."
        )
    elif not payload.get("has_gpu"):
        payload["gpu_features_message"] = (
            "GPU tier is enabled but no GPU worker is responding. "
            "Ensure worker-gpu is running (COMPOSE_PROFILES=gpu) and NVIDIA Container Toolkit is installed."
        )
    else:
        payload["gpu_features_message"] = None
    return payload


@router.get("/system/version")
async def get_app_version() -> dict[str, str]:
    """Application release version for the UI footer and diagnostics."""
    from ..lai_version import lai_version

    return {"version": lai_version()}


@router.get("/system/capabilities")
async def get_capabilities() -> dict[str, Any]:
    """High-level feature flags for the UI (CPU vs GPU tier)."""
    gpu = await get_gpu_status()
    tier = bool(gpu.get("gpu_tier_configured"))
    worker_up = bool(gpu.get("has_gpu")) or gpu.get("source") == "celery_worker"
    return {
        "annotation_available": True,
        "dataset_management_available": True,
        "training_available": tier and worker_up,
        "auto_annotate_available": tier and worker_up,
        "sam_available": tier and worker_up,
        "gpu_tier_configured": tier,
        "gpu_worker_available": worker_up,
        "message": gpu.get("gpu_features_message"),
    }


@router.get("/system/gpu")
async def get_gpu_status(debug: bool = False) -> dict[str, Any]:
    """
    Return GPU availability and memory usage for the backend (e.g. Docker) environment.
    Tries nvidia-smi first (full memory/utilization), then PyTorch CUDA if available.
    Add ?debug=1 to the URL to include a hint when no GPU is detected.
    """
    # Fast path: read worker-visible status (worker has GPU, backend may not).
    cached_db = _read_worker_gpu_status_db()
    if cached_db:
        return _enrich_gpu_payload(cached_db)

    # Fast path fallback: redis cache from worker.
    cached = _read_worker_gpu_status()
    if cached:
        return _enrich_gpu_payload({
            'has_gpu': bool(cached.get('has_gpu', False)),
            'gpu_count': int(cached.get('gpu_count', 0) or 0),
            'gpus': list(cached.get('gpus', [])),
            'memory_used_mb': int(cached.get('memory_used_mb', 0) or 0),
            'memory_total_mb': int(cached.get('memory_total_mb', 0) or 0),
            'source': cached.get('source', 'celery_worker'),
            'updated_at': cached.get('updated_at'),
        })

    # Mostly on-request refresh: ask worker for a fresh sample when no cache exists.
    if GPU_REFRESH_ON_REQUEST:
        _trigger_worker_gpu_refresh()
        cached_db = _read_worker_gpu_status_db()
        if cached_db:
            return _enrich_gpu_payload(cached_db)
        cached = _read_worker_gpu_status()
        if cached:
            return _enrich_gpu_payload({
                'has_gpu': bool(cached.get('has_gpu', False)),
                'gpu_count': int(cached.get('gpu_count', 0) or 0),
                'gpus': list(cached.get('gpus', [])),
                'memory_used_mb': int(cached.get('memory_used_mb', 0) or 0),
                'memory_total_mb': int(cached.get('memory_total_mb', 0) or 0),
                'source': cached.get('source', 'celery_worker'),
                'updated_at': cached.get('updated_at'),
            })

    # Cache miss means we do not yet know whether the worker has a GPU.
    # Do not claim "No GPU" here because backend may be CPU-only by design.
    if debug:
        return _enrich_gpu_payload({
            'has_gpu': False,
            'gpu_count': 0,
            'gpus': [],
            'memory_used_mb': 0,
            'memory_total_mb': 0,
            'source': 'unknown',
            'status': 'unknown',
            'debug': ['worker GPU cache miss'],
        })

    gpus, nvidia_debug = _query_gpu_nvidia_smi()
    if not gpus:
        gpus = _query_gpu_torch()
    total_used_mb = sum(g["memory_used_mb"] for g in gpus)
    total_mb = sum(g["memory_total_mb"] for g in gpus)
    # If we got GPUs from torch, memory_used may be 0; nvidia-smi gives system-wide
    if gpus and total_used_mb == 0 and total_mb > 0:
        again, _ = _query_gpu_nvidia_smi()
        if again:
            gpus = again
            total_used_mb = sum(g["memory_used_mb"] for g in gpus)
            total_mb = sum(g["memory_total_mb"] for g in gpus)
    out: dict[str, Any] = {
        "has_gpu": len(gpus) > 0,
        "gpu_count": len(gpus),
        "gpus": gpus,
        "memory_used_mb": total_used_mb,
        "memory_total_mb": total_mb,
        "source": "backend",
    }
    if debug and not gpus and nvidia_debug:
        out["debug"] = nvidia_debug
    return _enrich_gpu_payload(out)


# ---------------------------------------------------------------------------
# Foundation model inventory
# ---------------------------------------------------------------------------
from pathlib import Path as _Path

from ..foundation_models import (
    ARCH_SIZES,
    DEPTH_ONNX_NAMES,
    ultralytics_foundation_pt_names,
)
from ..model_weights_presence import PRETRAINED_MODELS_DIR, DEPTH_MODELS_DIR


def _yolo_meta(filename: str) -> dict[str, Any]:
    """Derive arch / size / task labels from a YOLO .pt filename."""
    stem = filename[:-3] if filename.endswith(".pt") else filename
    if stem.endswith("-seg"):
        task = "segment"
        base = stem[:-4]
    elif stem.endswith("-cls"):
        task = "classify"
        base = stem[:-4]
    else:
        task = "detect"
        base = stem
    arch, size = base, ""
    for a, s in ARCH_SIZES:
        candidate = f"{a}{s}"
        if candidate == base:
            arch, size = a, s
            break
    return {"arch": arch, "size": size, "task": task}


def _depth_meta(filename: str) -> dict[str, str]:
    # depth_anything_v2_<variant>_<environment>_dynamic.onnx
    parts = filename.replace("depth_anything_v2_", "").split("_")
    variant = parts[0] if parts else ""
    environment = parts[1] if len(parts) > 1 else ""
    return {"variant": variant, "environment": environment}


def _present(path: _Path) -> tuple[bool, int]:
    if path.is_file():
        try:
            return True, path.stat().st_size
        except OSError:
            return True, 0
    return False, 0


@router.get("/system/models")
async def list_foundation_models() -> dict[str, Any]:
    """
    Inventory the foundation weights mounted under /app/models and
    /app/ai_models/depth_estimation. Reports each known model as present
    or missing so the UI can guide users to fetch more.
    """
    yolo: list[dict[str, Any]] = []
    yolo_present = 0
    for fn in ultralytics_foundation_pt_names():
        ok, size = _present(PRETRAINED_MODELS_DIR / fn)
        if ok:
            yolo_present += 1
        meta = _yolo_meta(fn)
        yolo.append({
            "file": fn,
            "name": fn[:-3],
            "arch": meta["arch"],
            "size": meta["size"],
            "task": meta["task"],
            "present": ok,
            "size_mb": round(size / (1024 * 1024), 2) if size else 0,
        })

    depth: list[dict[str, Any]] = []
    depth_present = 0
    for fn in DEPTH_ONNX_NAMES:
        ok, size = _present(DEPTH_MODELS_DIR / fn)
        if ok:
            depth_present += 1
        meta = _depth_meta(fn)
        depth.append({
            "file": fn,
            "variant": meta["variant"],
            "environment": meta["environment"],
            "present": ok,
            "size_mb": round(size / (1024 * 1024), 2) if size else 0,
        })

    return {
        "yolo": yolo,
        "depth": depth,
        "summary": {
            "yolo_present": yolo_present,
            "yolo_total": len(yolo),
            "depth_present": depth_present,
            "depth_total": len(depth),
        },
        "paths": {
            "yolo_dir": str(PRETRAINED_MODELS_DIR),
            "depth_dir": str(DEPTH_MODELS_DIR),
        },
        "commands": {
            "all": "lai download-models --yolo all --depth all",
            "minimal": "lai download-models",
            "single_yolo": "lai download-models --yolo yolo11n-seg.pt",
            "single_depth": "lai download-models --depth depth_anything_v2_vitb_outdoor_dynamic.onnx",
            "direct": "docker compose exec worker-gpu python scripts/download_ultralytics_models.py",
        },
        "notice": (
            "Models live on a host volume — drop your own .pt files into the yolo_dir to use them. "
            "Missing weights are downloaded on demand the first time a job needs them (requires internet)."
        ),
    }
