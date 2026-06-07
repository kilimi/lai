"""
Backup management API endpoints
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
from pathlib import Path
import logging

from .. import models
from ..database import get_db, SQLALCHEMY_DATABASE_URL
from ..services.backup_service import BackupService

logger = logging.getLogger(__name__)

router = APIRouter()


class BackupSettingsRequest(BaseModel):
    enabled: bool
    backup_path: Optional[str] = None
    frequency_hours: int = 24
    retention_days: int = 30


class BackupResponse(BaseModel):
    success: bool
    message: str
    backup_id: Optional[int] = None
    backup_path: Optional[str] = None


@router.get("/backup/settings")
async def get_backup_settings(db: Session = Depends(get_db)):
    """Get current backup settings"""
    import os
    
    settings = db.query(models.BackupSettings).first()
    
    if not settings:
        # Create default settings - empty path means root of ./backups on host
        settings = models.BackupSettings(
            enabled=False,
            backup_path="",  # Empty = root of ./backups directory on host (mounted to /app/backups in container)
            frequency_hours=24,
            retention_days=30
        )
        db.add(settings)
        db.commit()
        db.refresh(settings)
    
    # Get BACKUP_PATH from environment (if set)
    backup_path_env = os.environ.get('BACKUP_PATH', None)
    
    return {
        "enabled": settings.enabled,
        "backup_path": settings.backup_path,
        "backup_path_env": backup_path_env,  # Show if BACKUP_PATH env var is set
        "frequency_hours": settings.frequency_hours,
        "retention_days": settings.retention_days,
        "last_backup_at": settings.last_backup_at.isoformat() if settings.last_backup_at else None,
        "next_backup_at": settings.next_backup_at.isoformat() if settings.next_backup_at else None,
    }


@router.post("/backup/settings")
async def update_backup_settings(
    request: BackupSettingsRequest,
    db: Session = Depends(get_db)
):
    """Update backup settings"""
    settings = db.query(models.BackupSettings).first()
    
    if not settings:
        settings = models.BackupSettings()
        db.add(settings)
    
    settings.enabled = request.enabled
    settings.frequency_hours = request.frequency_hours
    settings.retention_days = request.retention_days
    
    if request.backup_path is not None:
        # Validate backup path
        # The path can be:
        # 1. Empty string - use root of mounted backup directory
        # 2. Relative path (e.g., "daily") - subdirectory in mounted backup directory
        # 3. Absolute path - NOTE: This requires BACKUP_PATH env var to be set in docker-compose.yml
        #    The absolute path should match what's mounted to /app/backups
        backup_path_input = request.backup_path.strip() if request.backup_path else ""
        try:
            # Resolve to container path for validation
            # All paths are relative to /app/backups in container (which is mounted from host)
            if not backup_path_input or backup_path_input == ".":
                # Empty or "." means root of backups directory
                container_path = Path("/app/backups")
            elif backup_path_input.startswith('/'):
                # Absolute path provided - check if it's a valid container path
                if backup_path_input.startswith('/app/backups'):
                    # Path under /app/backups - use as-is
                    container_path = Path(backup_path_input)
                elif backup_path_input.startswith('/backups'):
                    # Alternative mount point
                    container_path = Path(backup_path_input)
                else:
                    # Absolute path outside expected locations
                    # This might be a host path - we can't validate it from container
                    # Store it but warn user they need to mount it in docker-compose.yml
                    logger.warning(f"Absolute path provided: {backup_path_input}. "
                                 f"Ensure this path is mounted to /app/backups in docker-compose.yml")
                    # For now, treat as relative to /app/backups
                    container_path = Path("/app/backups") / backup_path_input.lstrip('/')
            else:
                # Relative path - append to /app/backups
                container_path = Path("/app/backups") / backup_path_input
            
            # Create directory and test write access
            container_path.mkdir(parents=True, exist_ok=True)
            test_file = container_path / '.test_write'
            test_file.write_text('test')
            test_file.unlink()
            
            # Store user-provided path as-is
            settings.backup_path = backup_path_input
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid backup path '{request.backup_path}': {str(e)}. "
                       f"If using absolute path, ensure it's mounted in docker-compose.yml"
            )
    
    # Calculate next backup time if enabled
    if settings.enabled and settings.last_backup_at:
        settings.next_backup_at = settings.last_backup_at + timedelta(hours=settings.frequency_hours)
    elif settings.enabled:
        settings.next_backup_at = datetime.utcnow() + timedelta(hours=settings.frequency_hours)
    
    settings.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(settings)
    
    return {
        "success": True,
        "message": "Backup settings updated",
        "settings": {
            "enabled": settings.enabled,
            "backup_path": settings.backup_path,
            "frequency_hours": settings.frequency_hours,
            "retention_days": settings.retention_days,
            "next_backup_at": settings.next_backup_at.isoformat() if settings.next_backup_at else None,
        }
    }


@router.post("/backup/run")
async def run_backup(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """Manually trigger a backup"""
    settings = db.query(models.BackupSettings).first()
    
    if not settings or not settings.enabled:
        raise HTTPException(
            status_code=400,
            detail="Backup is not enabled. Please configure backup settings first."
        )
    
    if not settings.backup_path:
        raise HTTPException(
            status_code=400,
            detail="Backup path is not configured"
        )
    
    # Start backup in background
    background_tasks.add_task(perform_backup_task, settings.id)
    
    return {
        "success": True,
        "message": "Backup started in background"
    }


def perform_backup_task(settings_id: int):
    """Perform backup task (can be called from Celery or BackgroundTasks)"""
    from ..database import SessionLocal
    
    db = SessionLocal()
    try:
        settings = db.query(models.BackupSettings).filter(
            models.BackupSettings.id == settings_id
        ).first()
        
        if not settings or not settings.backup_path:
            logger.error("Backup settings not found or invalid")
            return
        
        # Initialize backup service (handle Docker paths)
        # User path is relative to ./backups on host, resolve to /app/backups in container
        backup_path_input = settings.backup_path or ""
        if backup_path_input and backup_path_input.startswith('/'):
            # Absolute path provided
            if backup_path_input.startswith('/app/backups'):
                container_backup_path = backup_path_input
            elif backup_path_input.startswith('/backups'):
                container_backup_path = backup_path_input
            else:
                # Other absolute path - treat as relative
                container_backup_path = str(Path("/app/backups") / backup_path_input.lstrip('/'))
        else:
            # Relative path or empty - resolve to /app/backups/{path}
            if backup_path_input:
                container_backup_path = str(Path("/app/backups") / backup_path_input)
            else:
                # Empty = root of backups directory
                container_backup_path = "/app/backups"
        
        backup_service = BackupService(container_backup_path)
        
        # Find the most recent backup for incremental backup
        backups = backup_service.list_backups()
        parent_backup_path = None
        backup_type = 'full'
        
        if backups:
            # Use most recent backup as parent
            parent_backup_path = Path(backups[0]['backup_path'])
            backup_type = 'incremental'
        
        # Create backup name with timestamp
        backup_name = f"backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        # Use container_backup_path (resolved path) instead of settings.backup_path
        backup_path = Path(container_backup_path) / backup_name
        
        # Create backup record
        backup_record = models.BackupRecord(
            backup_path=str(backup_path),
            backup_type=backup_type,
            status='in_progress',
            started_at=datetime.utcnow()
        )
        if parent_backup_path:
            parent_record = db.query(models.BackupRecord).filter(
                models.BackupRecord.backup_path == str(parent_backup_path)
            ).first()
            if parent_record:
                backup_record.parent_backup_id = parent_record.id
        
        db.add(backup_record)
        db.commit()
        db.refresh(backup_record)
        
        try:
            # Backup physical files (projects directory)
            # In Docker, this is /app/projects
            projects_dir = Path("/app/projects")
            if not projects_dir.exists():
                # Fallback to relative path
                projects_dir = Path("projects")
            if projects_dir.exists():
                file_backup_path, file_stats = backup_service.create_incremental_backup(
                    projects_dir,
                    backup_name,
                    parent_backup_path
                )
                backup_record.file_count = file_stats['total_files']
                backup_record.files_backed_up = True
            else:
                backup_record.files_backed_up = False
                logger.warning("Projects directory not found")
            
            # Backup database
            logger.info(f"Starting database backup to: {backup_path}")
            db_backed_up = backup_service.backup_database(
                SQLALCHEMY_DATABASE_URL,
                backup_path
            )
            backup_record.database_backed_up = db_backed_up
            if not db_backed_up:
                logger.error("Database backup failed - check logs for details")
            else:
                logger.info(f"Database backup completed successfully in: {backup_path / 'database'}")
            
            # Calculate total size
            if backup_path.exists():
                total_size = sum(
                    f.stat().st_size for f in backup_path.rglob('*') if f.is_file()
                )
                backup_record.total_size_bytes = total_size
            
            # Cleanup old backups
            deleted_backups = backup_service.cleanup_old_backups(settings.retention_days)
            if deleted_backups:
                logger.info(f"Deleted {len(deleted_backups)} old backups")
            
            # Update backup record
            backup_record.status = 'completed'
            backup_record.completed_at = datetime.utcnow()
            backup_record.backup_metadata = {
                'file_stats': file_stats if projects_dir.exists() else {},
                'deleted_backups': deleted_backups,
                'database_backed_up': db_backed_up,
                'files_backed_up': backup_record.files_backed_up
            }
            
            # Log backup summary
            logger.info(f"Backup completed: {backup_name}")
            logger.info(f"  - Files backed up: {backup_record.files_backed_up}")
            logger.info(f"  - Database backed up: {db_backed_up}")
            logger.info(f"  - Total size: {backup_record.total_size_bytes} bytes")
            logger.info(f"  - Location: {backup_path}")
            
            # Update settings
            settings.last_backup_at = datetime.utcnow()
            if settings.enabled:
                settings.next_backup_at = settings.last_backup_at + timedelta(hours=settings.frequency_hours)
            
            db.commit()
            
            logger.info(f"Backup completed successfully: {backup_name}")
            
        except Exception as e:
            logger.error(f"Backup failed: {e}", exc_info=True)
            backup_record.status = 'failed'
            backup_record.error_message = str(e)
            backup_record.completed_at = datetime.utcnow()
            db.commit()
            raise
        
    except Exception as e:
        logger.error(f"Backup task failed: {e}", exc_info=True)
    finally:
        db.close()


@router.get("/backup/list")
async def list_backups(db: Session = Depends(get_db)):
    """List all backups"""
    settings = db.query(models.BackupSettings).first()
    
    if not settings or not settings.backup_path:
        return {"backups": []}
    
    # Handle Docker paths - resolve user path to container path
    backup_path_input = settings.backup_path or ""
    if backup_path_input and backup_path_input.startswith('/'):
        if backup_path_input.startswith('/app/backups'):
            container_backup_path = backup_path_input
        elif backup_path_input.startswith('/backups'):
            container_backup_path = backup_path_input
        else:
            container_backup_path = str(Path("/app/backups") / backup_path_input.lstrip('/'))
    else:
        if backup_path_input:
            container_backup_path = str(Path("/app/backups") / backup_path_input)
        else:
            container_backup_path = "/app/backups"
    
    backup_service = BackupService(container_backup_path)
    backups = backup_service.list_backups()
    
    # Also get database records for additional info
    backup_records = db.query(models.BackupRecord).order_by(
        models.BackupRecord.started_at.desc()
    ).all()
    
    # Merge information
    backup_map = {b['backup_path']: b for b in backups}
    for record in backup_records:
        if record.backup_path in backup_map:
            backup_map[record.backup_path]['record_id'] = record.id
            backup_map[record.backup_path]['status'] = record.status
            backup_map[record.backup_path]['error_message'] = record.error_message
    
    return {
        "backups": list(backup_map.values()),
        "total": len(backups)
    }


@router.delete("/backup/{backup_id}")
async def delete_backup(backup_id: int, db: Session = Depends(get_db)):
    """Delete a specific backup"""
    backup_record = db.query(models.BackupRecord).filter(
        models.BackupRecord.id == backup_id
    ).first()
    
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
            "message": f"Backup {backup_id} deleted"
        }
    except Exception as e:
        logger.error(f"Error deleting backup: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete backup: {str(e)}")
