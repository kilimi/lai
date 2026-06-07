"""Shared Celery training infrastructure."""
import logging
import os
from datetime import datetime

from celery import Task

from app.database import SessionLocal
from app.models import Task as TaskModel

logger = logging.getLogger(__name__)

MMYOLO_PYTHON = os.environ.get("MMYOLO_PYTHON", "/opt/conda/envs/mmyolo/bin/python")
ULTRALYTICS_PYTHON = os.environ.get("ULTRALYTICS_PYTHON", "/opt/conda/bin/python")


def _ultralytics_class(class_name: str, fallback_paths: tuple) -> type:
    """
    Import a named class from the ultralytics package with version-robust fallbacks.

    Tries submodule paths first, then top-level (after lazy-export patch).
    """
    from app.ml.numpy_compat import ensure_numpy_torch_compat
    from app.ml.runtime_env import ensure_ultralytics_sys_path
    from app.ml.ultralytics_compat import patch_ultralytics_lazy_exports

    ensure_numpy_torch_compat()
    ensure_ultralytics_sys_path()
    patch_ultralytics_lazy_exports()

    import importlib

    all_paths = fallback_paths + ("ultralytics",)
    last_error: Exception | None = None
    for mod_path in all_paths:
        try:
            mod = importlib.import_module(mod_path)
            cls = getattr(mod, class_name, None)
            if cls is not None:
                return cls
        except Exception as exc:
            last_error = exc
            continue
    raise ImportError(
        f"Cannot import {class_name} from ultralytics. "
        "Check that ultralytics is properly installed in this environment."
        + (f" Last error: {last_error}" if last_error else "")
    )


def get_ultralytics_yolo():
    """Return the Ultralytics YOLO class, trying multiple import paths."""
    return _ultralytics_class(
        "YOLO",
        (
            "ultralytics.models.yolo.model",
            "ultralytics.models.yolo",
            "ultralytics.models",
        ),
    )


def get_ultralytics_rtdetr():
    """Return the Ultralytics RTDETR class, trying multiple import paths."""
    return _ultralytics_class(
        "RTDETR",
        (
            "ultralytics.models.rtdetr",
            "ultralytics.models",
        ),
    )


class TrainingTask(Task):
    """Base task for training with progress tracking."""

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails."""
        logger.error(f"Task {task_id} failed: {exc}")

        db = SessionLocal()
        try:
            if not args:
                return
            db_task_id = args[0]
            task = db.query(TaskModel).filter(TaskModel.id == db_task_id).first()
            if not task:
                return

            task_meta = task.task_metadata or {}
            pause_requested = isinstance(task_meta, dict) and bool(task_meta.get("pause_requested_at"))
            stop_requested = isinstance(task_meta, dict) and bool(task_meta.get("stop_requested_at"))

            if task.status in ("stopped", "paused") or pause_requested or stop_requested:
                if pause_requested and task.status != "paused":
                    task.status = "paused"
                    task.task_metadata = {
                        **task_meta,
                        "stage": "paused",
                        "pause_requested_at": None,
                    }
                    db.commit()
                    logger.info(f"DB task {db_task_id} finalized as paused during on_failure")
                    return
                if stop_requested and task.status not in ("stopped", "paused"):
                    task.status = "stopped"
                    task.completed_at = datetime.utcnow()
                    task.error_message = "Task stopped by user"
                    task.task_metadata = {**task_meta, "stage": "stopped"}
                    db.commit()
                logger.info(
                    f"DB task {db_task_id} already has status='{task.status}', skipping on_failure update"
                )
                return

            task.status = "failed"
            task.completed_at = datetime.utcnow()
            task.error_message = str(exc)
            db.commit()
        finally:
            db.close()
