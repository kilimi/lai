"""Cooperative cancellation for long-running DB-backed tasks."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session


class TaskStopped(Exception):
    """Raised when a task was stopped/cancelled by the user."""


def task_stop_requested(task: Any) -> bool:
    if not task:
        return False
    meta = task.task_metadata if isinstance(task.task_metadata, dict) else {}
    return task.status in ("stopped", "cancelled") or bool(meta.get("stop_requested_at"))


def check_task_stop(db: Session, task_id: int) -> None:
    """Refresh task row and abort if stop was requested."""
    from app.models import Task

    task = db.query(Task).filter(Task.id == task_id).first()
    if task is not None:
        db.refresh(task)
    if task_stop_requested(task):
        raise TaskStopped("Task stopped by user")


def mark_annotation_file_stopped(
    db: Session,
    file_id: str,
    message: str = "Processing stopped by user",
) -> None:
    from app.models import AnnotationFile

    annotation_file = db.query(AnnotationFile).filter(AnnotationFile.id == file_id).first()
    if not annotation_file:
        return
    annotation_file.processing_status = "failed"
    annotation_file.error_message = message
    annotation_file.is_processed = False
    db.commit()


def finalize_running_task(
    db: Session,
    task_id: int,
    *,
    success_status: str = "completed",
) -> bool:
    """
    Mark a running task completed unless it was stopped.
    Returns True when finalized as success.
    """
    from app.models import Task

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return False
    db.refresh(task)
    if task_stop_requested(task):
        if task.status != "stopped":
            task.status = "stopped"
        if not task.completed_at:
            task.completed_at = datetime.now(timezone.utc)
        if not task.error_message:
            task.error_message = "Task stopped by user"
        db.commit()
        return False
    if task.status == "failed":
        return False
    task.status = success_status
    task.completed_at = datetime.now(timezone.utc)
    if success_status == "completed":
        task.progress = 100.0
    db.commit()
    return True


def handle_task_failure_status(
    db: Session,
    task_id: int,
    exc: BaseException,
) -> None:
    """Set failed unless the user already stopped the task."""
    from app.models import Task

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        return
    db.refresh(task)
    if task_stop_requested(task):
        if task.status != "stopped":
            task.status = "stopped"
        if not task.completed_at:
            task.completed_at = datetime.now(timezone.utc)
        if not task.error_message:
            task.error_message = "Task stopped by user"
        db.commit()
        return
    task.status = "failed"
    task.completed_at = datetime.now(timezone.utc)
    task.error_message = str(exc)
    db.commit()


def run_annotation_file_processing(
    db: Session,
    *,
    task_id: int,
    file_id: str,
    coco_data: dict,
) -> None:
    """Shared entry for Celery and in-process annotation import workers."""
    from app import models
    from app.services.annotation_processing import process_coco_annotation_file_task

    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if task_stop_requested(task):
        return

    process_coco_annotation_file_task(
        task_id=task_id,
        file_id=file_id,
        coco_data=coco_data,
        db=db,
    )
    finalize_running_task(db, task_id)
