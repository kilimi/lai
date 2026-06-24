"""Celery worker: INSID3 find-similar across a dataset layer."""
from __future__ import annotations

import logging
from datetime import datetime

from celery import Task

from app.celery.general_app import celery_app

logger = logging.getLogger(__name__)


class Insid3PropagateTask(Task):
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error("INSID3 propagate Celery task %s failed: %s", task_id, exc)
        from app.database import SessionLocal
        from app import models

        db = SessionLocal()
        try:
            if args:
                db_task_id = args[0]
                task = db.query(models.Task).filter(models.Task.id == db_task_id).first()
                if task and task.status != "cancelled":
                    task.status = "failed"
                    task.error_message = str(exc)
                    task.completed_at = datetime.utcnow()
                    db.commit()
        finally:
            db.close()


@celery_app.task(
    base=Insid3PropagateTask,
    bind=True,
    name="app.tasks.insid3_tasks.run_insid3_propagate",
    time_limit=7200,
    soft_time_limit=7000,
)
def run_insid3_propagate(self, task_id: int):
    from app.services.insid3_propagate_service import run_insid3_propagate_work

    logger.info("Starting insid3_propagate for task_id=%s", task_id)
    run_insid3_propagate_work(task_id)
    return {"task_id": task_id}
