"""
Celery tasks for manual backups (triggered from Settings → Run Backup).
"""
from celery import Task
import logging

from app.celery.general_app import celery_app
from ..services.backup_runner import run_backup

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
    """Run a user-initiated backup on worker-general (not the API process)."""
    logger.info("Starting manual backup for settings_id=%s", settings_id)
    result = run_backup(settings_id)
    if result.status == "failed":
        return {"status": "failed", "error": result.error, "backup_id": result.backup_id}
    return {
        "status": result.status,
        "backup_id": result.backup_id,
        "backup_path": result.backup_path,
    }
