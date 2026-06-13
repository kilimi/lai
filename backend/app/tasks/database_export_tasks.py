"""Celery task: database export (JSON or ZIP with project files)."""
from __future__ import annotations

import logging

from celery import Task

from app.celery.general_app import celery_app
from app.services.database_export_service import run_database_export

logger = logging.getLogger(__name__)


class DatabaseExportTask(Task):
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error("Database export Celery task %s failed: %s", task_id, exc, exc_info=einfo)
        super().on_failure(exc, task_id, args, kwargs, einfo)


@celery_app.task(
    base=DatabaseExportTask,
    bind=True,
    name="app.tasks.database_export_tasks.export_database",
    time_limit=7200,
    soft_time_limit=7000,
)
def export_database(self, task_id: int):
    logger.info("Starting database_export Celery job for task_id=%s", task_id)
    run_database_export(task_id)
    return {"task_id": task_id}
