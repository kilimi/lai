"""
Celery tasks for automatic backups
"""
from celery import Task
from datetime import datetime
import logging
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.general_app import celery_app
from .. import models
from ..database import SQLALCHEMY_DATABASE_URL
from ..services.backup_runner import is_backup_configured, run_backup

logger = logging.getLogger(__name__)

engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class BackupTask(Task):
    """Base class for backup tasks with database session management"""

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error(f"Backup task {task_id} failed: {exc}", exc_info=einfo)
        super().on_failure(exc, task_id, args, kwargs, einfo)


@celery_app.task(
    base=BackupTask,
    bind=True,
    name="app.tasks.backup_tasks.run_automatic_backup",
    time_limit=7200,
    soft_time_limit=7000,
)
def run_automatic_backup(self):
    """
    Check if automatic backup should run and execute it.
    This task is called periodically by Celery Beat.
    """
    db = SessionLocal()
    try:
        settings = db.query(models.BackupSettings).first()

        if not is_backup_configured(settings):
            logger.debug("Backup is disabled or not configured, skipping")
            return {"status": "skipped", "reason": "backup_disabled"}

        now = datetime.utcnow()
        if settings.next_backup_at and now < settings.next_backup_at:
            logger.debug(
                f"Not time for backup yet. Next backup at: {settings.next_backup_at}"
            )
            return {
                "status": "skipped",
                "reason": "not_due_yet",
                "next_backup_at": settings.next_backup_at.isoformat(),
            }

        logger.info("Starting automatic backup")
        result = run_backup(settings.id)

        if result.status == "failed":
            return {"status": "failed", "error": result.error}

        return {
            "status": result.status,
            "backup_time": now.isoformat(),
            "backup_id": result.backup_id,
        }

    except Exception as e:
        logger.error(f"Automatic backup task failed: {e}", exc_info=True)
        return {"status": "failed", "error": str(e)}
    finally:
        db.close()
