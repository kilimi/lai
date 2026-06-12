"""
Backup management API endpoints
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from pathlib import Path
import logging
import os

from .. import models
from ..database import get_db
from ..services.backup_service import BackupService
from ..services.backup_runner import (
    resolve_backup_paths,
    is_backup_path_configured,
    has_in_progress_backup,
    run_backup,
    run_restore,
)
from ..task_dispatch import use_celery_enabled

logger = logging.getLogger(__name__)

router = APIRouter()


class BackupSettingsRequest(BaseModel):
    backup_path: Optional[str] = None
    retention_days: int = 30


class RestoreRequest(BaseModel):
    restore_database: bool = True
    restore_files: bool = True
    confirm: str


def _ensure_backup_settings(db: Session) -> models.BackupSettings:
    settings = db.query(models.BackupSettings).first()
    if not settings:
        settings = models.BackupSettings(
            enabled=False,
            backup_path="",
            frequency_hours=24,
            retention_days=30,
        )
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings


@router.get("/backup/settings")
async def get_backup_settings(db: Session = Depends(get_db)):
    """Get current backup settings"""
    settings = _ensure_backup_settings(db)
    backup_path_env = os.environ.get("BACKUP_PATH", None)

    return {
        "backup_path": settings.backup_path if settings.backup_path is not None else "",
        "backup_path_env": backup_path_env,
        "retention_days": settings.retention_days,
        "last_backup_at": settings.last_backup_at.isoformat() if settings.last_backup_at else None,
    }


@router.post("/backup/settings")
async def update_backup_settings(
    request: BackupSettingsRequest,
    db: Session = Depends(get_db),
):
    """Update backup settings (path and retention; backups are manual only)."""
    settings = _ensure_backup_settings(db)
    settings.retention_days = request.retention_days

    if request.backup_path is not None:
        backup_path_input = request.backup_path.strip() if request.backup_path else ""
        try:
            _, container_path = resolve_backup_paths(backup_path_input)
            container_path_obj = Path(container_path)
            container_path_obj.mkdir(parents=True, exist_ok=True)
            test_file = container_path_obj / ".test_write"
            test_file.write_text("test")
            test_file.unlink()
            settings.backup_path = backup_path_input
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid backup path '{request.backup_path}': {str(e)}. "
                    "If using absolute path, ensure it's mounted in docker-compose.yml"
                ),
            )

    settings.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(settings)

    return {
        "success": True,
        "message": "Backup settings updated",
        "settings": {
            "backup_path": settings.backup_path,
            "retention_days": settings.retention_days,
            "last_backup_at": settings.last_backup_at.isoformat()
            if settings.last_backup_at
            else None,
        },
    }


def _dispatch_manual_backup(settings_id: int, background_tasks: BackgroundTasks) -> None:
    if use_celery_enabled():
        from app.tasks.backup_tasks import run_manual_backup

        run_manual_backup.delay(settings_id)
        return
    background_tasks.add_task(run_backup, settings_id)


@router.post("/backup/run")
async def trigger_backup(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Manually trigger a backup"""
    settings = _ensure_backup_settings(db)

    if not is_backup_path_configured(settings):
        raise HTTPException(
            status_code=400,
            detail="Backup path is not configured. Save backup settings first.",
        )

    if has_in_progress_backup(db):
        raise HTTPException(
            status_code=409,
            detail="A backup is already in progress",
        )

    _dispatch_manual_backup(settings.id, background_tasks)

    return {
        "success": True,
        "message": "Backup started in background",
    }


@router.get("/backup/list")
async def list_backups(db: Session = Depends(get_db)):
    """List all backups"""
    settings = db.query(models.BackupSettings).first()

    if not settings or not is_backup_path_configured(settings):
        return {"backups": [], "total": 0}

    _, container_backup_path = resolve_backup_paths(settings.backup_path)
    backup_service = BackupService(container_backup_path)
    backups = backup_service.list_backups()

    backup_records = (
        db.query(models.BackupRecord)
        .order_by(models.BackupRecord.started_at.desc())
        .all()
    )

    backup_map = {b["backup_path"]: b for b in backups}
    for record in backup_records:
        path = record.backup_path
        if path not in backup_map:
            backup_map[path] = {
                "backup_path": path,
                "backup_name": Path(path).name,
            }
        entry = backup_map[path]
        entry["record_id"] = record.id
        entry["status"] = record.status
        entry["error_message"] = record.error_message
        entry["database_backed_up"] = record.database_backed_up
        entry["files_backed_up"] = record.files_backed_up
        entry["backup_type"] = record.backup_type
        if record.backup_metadata:
            entry["backup_metadata"] = record.backup_metadata

    return {
        "backups": list(backup_map.values()),
        "total": len(backup_map),
    }


@router.get("/backup/{backup_id}")
async def get_backup(backup_id: int, db: Session = Depends(get_db)):
    """Get snapshot detail and restore readiness"""
    record = (
        db.query(models.BackupRecord)
        .filter(models.BackupRecord.id == backup_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Backup not found")

    backup_dir = Path(record.backup_path)
    validation = {}
    if backup_dir.exists():
        service = BackupService(str(backup_dir.parent))
        validation = service.validate_snapshot(backup_dir)

    return {
        "id": record.id,
        "backup_path": record.backup_path,
        "backup_type": record.backup_type,
        "status": record.status,
        "database_backed_up": record.database_backed_up,
        "files_backed_up": record.files_backed_up,
        "total_size_bytes": record.total_size_bytes,
        "started_at": record.started_at.isoformat() if record.started_at else None,
        "completed_at": record.completed_at.isoformat() if record.completed_at else None,
        "error_message": record.error_message,
        "backup_metadata": record.backup_metadata,
        "can_restore": record.status in ("completed", "partial"),
        **validation,
    }


@router.post("/backup/{backup_id}/restore")
async def restore_backup(
    backup_id: int,
    request: RestoreRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Restore from a backup snapshot"""
    if request.confirm != "RESTORE":
        raise HTTPException(
            status_code=400,
            detail='Confirmation required: set confirm to "RESTORE"',
        )

    if not request.restore_database and not request.restore_files:
        raise HTTPException(
            status_code=400,
            detail="Select at least one of restore_database or restore_files",
        )

    record = (
        db.query(models.BackupRecord)
        .filter(models.BackupRecord.id == backup_id)
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail="Backup not found")

    if record.status not in ("completed", "partial"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot restore backup with status '{record.status}'",
        )

    if has_in_progress_backup(db):
        raise HTTPException(
            status_code=409,
            detail="A backup is already in progress",
        )

    logger.info(
        "Restore requested: backup_id=%s db=%s files=%s",
        backup_id,
        request.restore_database,
        request.restore_files,
    )

    background_tasks.add_task(
        run_restore,
        backup_id,
        restore_database=request.restore_database,
        restore_files=request.restore_files,
    )

    return {
        "success": True,
        "message": "Restore started in background",
        "backup_id": backup_id,
    }


@router.delete("/backup/{backup_id}")
async def delete_backup(backup_id: int, db: Session = Depends(get_db)):
    """Delete a specific backup"""
    backup_record = (
        db.query(models.BackupRecord)
        .filter(models.BackupRecord.id == backup_id)
        .first()
    )

    if not backup_record:
        raise HTTPException(status_code=404, detail="Backup not found")

    backup_path = Path(backup_record.backup_path)

    try:
        if backup_path.exists():
            import shutil

            shutil.rmtree(backup_path)
            logger.info(f"Deleted backup: {backup_path}")

        db.delete(backup_record)
        db.commit()

        return {
            "success": True,
            "message": f"Backup {backup_id} deleted",
        }
    except Exception as e:
        logger.error(f"Error deleting backup: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete backup: {str(e)}")
