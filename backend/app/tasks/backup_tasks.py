"""
Celery tasks for backups (manual trigger + scheduled auto-backup).

Heavy work runs on worker-general via run_backup(); Beat only runs the
lightweight check_scheduled_backups tick.
"""
from celery import Task
import logging

from app.celery.general_app import celery_app
from ..database import SessionLocal
from .. import models
from ..services.backup_runner import (
    has_in_progress_backup,
    is_automatic_backup_due,
    is_backup_path_configured,
    run_backup,
    run_restore,
)

logger = logging.getLogger(__name__)


class BackupTask(Task):
    """Base class for backup tasks with failure logging."""

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error(f"Backup task {task_id} failed: {exc}", exc_info=einfo)
        super().on_failure(exc, task_id, args, kwargs, einfo)


@celery_app.task(
    base=BackupTask,
    bind=True,
    name="app.tasks.backup_tasks.run_manual_backup",
    time_limit=7200,
    soft_time_limit=7000,
)
def run_manual_backup(self, settings_id: int):
    """Run a backup on worker-general (manual or dispatched by the scheduler)."""
    logger.info("Starting backup for settings_id=%s", settings_id)
    result = run_backup(settings_id)
    if result.status == "failed":
        return {"status": "failed", "error": result.error, "backup_id": result.backup_id}
    return {
        "status": result.status,
        "backup_id": result.backup_id,
        "backup_path": result.backup_path,
    }


@celery_app.task(
    base=BackupTask,
    bind=True,
    name="app.tasks.backup_tasks.check_scheduled_backups",
    time_limit=120,
    soft_time_limit=90,
)
def check_scheduled_backups(self):
    """
    Celery Beat tick: enqueue run_manual_backup when auto-backup is due.

    Does not perform pg_dump itself — only reads settings and dispatches.
    """
    db = SessionLocal()
    try:
        settings = db.query(models.BackupSettings).first()
        if not settings or not is_automatic_backup_due(settings):
            return {"status": "skipped", "reason": "not_due"}

        if not is_backup_path_configured(settings):
            logger.warning("Auto-backup enabled but backup path is not configured")
            return {"status": "skipped", "reason": "invalid_path"}

        if has_in_progress_backup(db):
            return {"status": "skipped", "reason": "in_progress"}

        run_manual_backup.delay(settings.id)
        logger.info("Dispatched scheduled backup for settings_id=%s", settings.id)
        return {"status": "dispatched", "settings_id": settings.id}
    finally:
        db.close()


@celery_app.task(
    base=BackupTask,
    bind=True,
    name="app.tasks.backup_tasks.run_restore_backup",
    time_limit=7200,
    soft_time_limit=7000,
)
def run_restore_backup(
    self,
    backup_record_id: int,
    *,
    restore_database: bool = True,
    restore_files: bool = True,
):
    """Restore a snapshot on worker-general (pg_restore + project files)."""
    logger.info(
        "Starting restore backup_id=%s db=%s files=%s",
        backup_record_id,
        restore_database,
        restore_files,
    )
    result = run_restore(
        backup_record_id,
        restore_database=restore_database,
        restore_files=restore_files,
    )
    if not result.success:
        return {
            "status": "failed",
            "error": result.error,
            "database_restored": result.database_restored,
            "files_restored": result.files_restored,
        }
    return {
        "status": result.status,
        "database_restored": result.database_restored,
        "files_restored": result.files_restored,
        "rollback_path": result.rollback_path,
    }
