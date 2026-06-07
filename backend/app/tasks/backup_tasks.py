"""
Celery tasks for automatic backups
"""
from celery import Task
from datetime import datetime, timedelta
import logging
from sqlalchemy.orm import Session
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.general_app import celery_app
from .. import models
from ..database import SQLALCHEMY_DATABASE_URL

logger = logging.getLogger(__name__)

# Database setup for Celery workers
engine = create_engine(SQLALCHEMY_DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class BackupTask(Task):
    """Base class for backup tasks with database session management"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Handle task failure"""
        logger.error(f"Backup task {task_id} failed: {exc}", exc_info=einfo)
        super().on_failure(exc, task_id, args, kwargs, einfo)


@celery_app.task(base=BackupTask, bind=True, name='app.tasks.backup_tasks.run_automatic_backup')
def run_automatic_backup(self):
    """
    Check if automatic backup should run and execute it.
    This task is called periodically by Celery Beat.
    """
    db = SessionLocal()
    try:
        settings = db.query(models.BackupSettings).first()
        
        if not settings or not settings.enabled:
            logger.debug("Backup is disabled, skipping")
            return {"status": "skipped", "reason": "backup_disabled"}
        
        if not settings.backup_path:
            logger.warning("Backup path not configured")
            return {"status": "skipped", "reason": "no_backup_path"}
        
        # Check if it's time to backup
        now = datetime.utcnow()
        if settings.next_backup_at and now < settings.next_backup_at:
            logger.debug(f"Not time for backup yet. Next backup at: {settings.next_backup_at}")
            return {"status": "skipped", "reason": "not_due_yet", "next_backup_at": settings.next_backup_at.isoformat()}
        
        # Import here to avoid circular imports
        from ..routers.backup import perform_backup_task
        
        # Run backup
        logger.info("Starting automatic backup")
        perform_backup_task(settings.id)
        
        return {"status": "completed", "backup_time": now.isoformat()}
        
    except Exception as e:
        logger.error(f"Automatic backup task failed: {e}", exc_info=True)
        return {"status": "failed", "error": str(e)}
    finally:
        db.close()
