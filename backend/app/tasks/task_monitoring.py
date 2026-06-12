"""
Periodic watchdog tasks for task lifecycle monitoring.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.celery.general_app import celery_app
from app.models import Task as TaskModel

logger = logging.getLogger(__name__)

# Database setup for Celery workers
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@db/lai_db")
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"connect_timeout": 10},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _is_transient_db_error(exc: BaseException) -> bool:
    """True when Postgres is restarting or briefly unreachable."""
    message = str(getattr(exc, "orig", exc)).lower()
    markers = (
        "the database system is starting up",
        "could not connect to server",
        "connection refused",
        "server closed the connection unexpectedly",
        "timeout expired",
    )
    return any(marker in message for marker in markers)


def _parse_iso_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def _snapshot(task: TaskModel) -> Dict[str, Any]:
    metadata = task.task_metadata or {}
    return {
        "progress": float(task.progress or 0.0),
        "stage": metadata.get("stage"),
        "status": task.status,
    }


@celery_app.task(name="app.tasks.task_monitoring.auto_cancel_stale_tasks")
def auto_cancel_stale_tasks() -> Dict[str, Any]:
    """
    Auto-cancel pending/running tasks that show no activity for too long.

    Activity is detected by changes to progress or stage.
    """
    timeout_hours = int(os.environ.get("LAI_STALE_TASK_TIMEOUT_HOURS", "12"))
    now = datetime.utcnow()
    stale_cutoff = now - timedelta(hours=timeout_hours)

    db = SessionLocal()
    scanned = 0
    cancelled = 0
    touched = 0
    errors = 0

    try:
        active_tasks = db.query(TaskModel).filter(TaskModel.status.in_(["pending", "running"])).all()
        scanned = len(active_tasks)

        for task in active_tasks:
            metadata = dict(task.task_metadata or {})
            snap = _snapshot(task)
            last_progress = metadata.get("_watchdog_last_progress")
            last_stage = metadata.get("_watchdog_last_stage")
            last_activity = _parse_iso_dt(metadata.get("_watchdog_last_activity_at"))

            # First monitor pass for this task: initialize tracking metadata.
            if last_activity is None:
                baseline = task.started_at or task.created_at or now
                metadata["_watchdog_last_activity_at"] = baseline.isoformat()
                metadata["_watchdog_last_progress"] = snap["progress"]
                metadata["_watchdog_last_stage"] = snap["stage"]
                task.task_metadata = metadata
                touched += 1
                continue

            # Any progress/stage change = activity heartbeat.
            if last_progress != snap["progress"] or last_stage != snap["stage"]:
                metadata["_watchdog_last_activity_at"] = now.isoformat()
                metadata["_watchdog_last_progress"] = snap["progress"]
                metadata["_watchdog_last_stage"] = snap["stage"]
                task.task_metadata = metadata
                touched += 1
                continue

            # No activity long enough -> auto-cancel.
            if last_activity < stale_cutoff:
                celery_task_id = metadata.get("celery_task_id")
                task.status = "cancelled"
                task.completed_at = now
                task.error_message = (
                    f"Task auto-cancelled by monitor after {timeout_hours}h without progress/activity update."
                )
                metadata["auto_cancelled_by_monitor"] = True
                metadata["auto_cancelled_at"] = now.isoformat()
                task.task_metadata = metadata
                cancelled += 1

                if celery_task_id:
                    try:
                        celery_app.control.revoke(celery_task_id, terminate=True, signal="SIGTERM")
                        logger.info(
                            "Task monitor revoked Celery task %s for stale task %s",
                            celery_task_id,
                            task.id,
                        )
                    except Exception as revoke_error:
                        errors += 1
                        logger.warning(
                            "Task monitor failed to revoke Celery task %s for task %s: %s",
                            celery_task_id,
                            task.id,
                            revoke_error,
                        )

        db.commit()
        logger.info(
            "Task monitor scan complete: scanned=%s touched=%s cancelled=%s errors=%s timeout_hours=%s",
            scanned,
            touched,
            cancelled,
            errors,
            timeout_hours,
        )
        return {
            "success": True,
            "scanned": scanned,
            "touched": touched,
            "cancelled": cancelled,
            "errors": errors,
            "timeout_hours": timeout_hours,
        }
    except OperationalError as e:
        db.rollback()
        if _is_transient_db_error(e):
            logger.warning(
                "Task monitor skipped: database unavailable (%s)",
                getattr(e, "orig", e),
            )
            return {
                "success": False,
                "skipped": True,
                "reason": "database_unavailable",
            }
        logger.error("Task monitor failed: %s", e, exc_info=True)
        raise
    except Exception as e:
        db.rollback()
        logger.error("Task monitor failed: %s", e, exc_info=True)
        raise
    finally:
        db.close()
