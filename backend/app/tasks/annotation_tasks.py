"""
Celery tasks for annotation file processing and merging (CPU / I/O).
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from celery import Task
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.celery.general_app import celery_app
from app.task_stop import (
    TaskStopped,
    finalize_running_task,
    handle_task_failure_status,
    run_annotation_file_processing,
    task_stop_requested,
)

logger = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@db/lai_db")
engine = create_engine(DATABASE_URL)
SessionLocalWorker = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class AnnotationTask(Task):
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error("Annotation task %s failed: %s", task_id, exc)
        if not args:
            return
        db_task_id = args[0]
        db = SessionLocalWorker()
        try:
            if isinstance(exc, TaskStopped):
                handle_task_failure_status(db, db_task_id, exc)
                return
            handle_task_failure_status(db, db_task_id, exc)
        finally:
            db.close()


@celery_app.task(
    base=AnnotationTask,
    bind=True,
    name="app.tasks.annotation_tasks.process_annotation_file",
)
def process_annotation_file(
    self,
    task_id: int,
    dataset_id: int,
    file_id: str,
):
    """Process an uploaded COCO annotation file (replaces API background thread)."""
    db = SessionLocalWorker()
    try:
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        metadata = dict(task.task_metadata or {})
        coco_data = metadata.get("coco_data")
        if not coco_data:
            raise ValueError("task_metadata.coco_data is required for annotation processing")

        if task_stop_requested(task):
            return

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 10
        db.commit()

        run_annotation_file_processing(
            db,
            task_id=task_id,
            file_id=file_id,
            coco_data=coco_data,
        )
        logger.info("Annotation processing finished for task %s", task_id)
    except TaskStopped:
        logger.info("Annotation processing stopped for task %s", task_id)
    except Exception:
        raise
    finally:
        db.close()


@celery_app.task(
    base=AnnotationTask,
    bind=True,
    name="app.tasks.annotation_tasks.merge_annotation_files",
)
def merge_annotation_files(
    self,
    task_id: int,
    dataset_id: int,
    file_ids: List[str],
    merged_filename: str,
    strategy_cfg: Optional[Dict[str, Any]] = None,
):
    """Merge annotation files (replaces API background thread)."""
    from app.services.dataset_annotation_merge_service import merge_annotation_files_task

    try:
        asyncio.run(
            merge_annotation_files_task(
                task_id=task_id,
                dataset_id=dataset_id,
                file_ids=file_ids,
                merged_filename=merged_filename,
                strategy_cfg=strategy_cfg,
            )
        )
    except TaskStopped:
        logger.info("Annotation merge stopped for task %s", task_id)
