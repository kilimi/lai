"""
Backup orchestration: path resolution, run backup, restore from snapshot.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from pathlib import Path, PurePosixPath
from typing import Optional, Tuple

from .. import models
from ..database import SQLALCHEMY_DATABASE_URL, SessionLocal
from .backup_service import BackupService

logger = logging.getLogger(__name__)

BACKUP_CONTAINER_ROOT = "/app/backups"


def resolve_backup_paths(backup_path_input: Optional[str]) -> Tuple[str, str]:
    """
    Resolve user-configured backup path to stored + container base paths.

    Empty string or "." means root of /app/backups.
    Returns (stored_path, container_base_path).
    """
    stored = (backup_path_input or "").strip()
    if stored == ".":
        stored = ""

    if stored.startswith("/"):
        if stored.startswith("/app/backups"):
            container = stored
        elif stored.startswith("/backups"):
            container = stored
        else:
            container = str(PurePosixPath(BACKUP_CONTAINER_ROOT) / stored.lstrip("/"))
    elif stored:
        container = str(PurePosixPath(BACKUP_CONTAINER_ROOT) / stored)
    else:
        container = BACKUP_CONTAINER_ROOT

    return stored, container


def is_backup_path_configured(settings: models.BackupSettings) -> bool:
    """True when backup path is valid (including empty = root of /app/backups)."""
    if settings is None:
        return False
    if settings.backup_path is None:
        return False
    return True


def is_backup_configured(settings: models.BackupSettings) -> bool:
    """True when backup path is configured."""
    return is_backup_path_configured(settings)


def is_automatic_backup_enabled(settings: models.BackupSettings) -> bool:
    return bool(settings and settings.enabled and is_backup_path_configured(settings))


def compute_next_backup_at(
    settings: models.BackupSettings,
    *,
    from_time: Optional[datetime] = None,
) -> datetime:
    """Next scheduled run after a successful backup (or when enabling auto-backup)."""
    hours = max(1, int(settings.frequency_hours or 24))
    base = from_time or settings.last_backup_at or datetime.utcnow()
    return base + timedelta(hours=hours)


def is_automatic_backup_due(
    settings: models.BackupSettings,
    now: Optional[datetime] = None,
) -> bool:
    if not is_automatic_backup_enabled(settings):
        return False
    now = now or datetime.utcnow()
    if settings.next_backup_at is None:
        return True
    return now >= settings.next_backup_at


def get_projects_dir() -> Path:
    projects_dir = Path("/app/projects")
    if not projects_dir.exists():
        projects_dir = Path("projects")
    return projects_dir


def has_in_progress_backup(db) -> bool:
    return (
        db.query(models.BackupRecord)
        .filter(models.BackupRecord.status == "in_progress")
        .first()
        is not None
    )


@dataclass
class BackupResult:
    backup_id: Optional[int] = None
    backup_path: Optional[str] = None
    status: str = "failed"
    error: Optional[str] = None


def _ensure_backup_metadata_file(
    backup_path: Path,
    backup_name: str,
    *,
    parent_backup_path: Optional[Path] = None,
    stats: Optional[dict] = None,
) -> None:
    """Write .backup_metadata.json so list_backups can find DB-only snapshots."""
    metadata_file = backup_path / ".backup_metadata.json"
    if metadata_file.exists():
        return
    backup_path.mkdir(parents=True, exist_ok=True)
    with open(metadata_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "backup_name": backup_name,
                "created_at": datetime.utcnow().isoformat(),
                "parent_backup": str(parent_backup_path) if parent_backup_path else None,
                "stats": stats or {},
            },
            f,
            indent=2,
        )
    if files_ok and db_ok:
        return "completed"
    if files_ok or db_ok:
        return "partial"
    return "failed"


def run_backup(settings_id: int) -> BackupResult:
    """Perform backup (manual BackgroundTasks or Celery scheduled)."""
    db = SessionLocal()
    file_stats: dict = {}
    try:
        settings = (
            db.query(models.BackupSettings)
            .filter(models.BackupSettings.id == settings_id)
            .first()
        )

        if not settings or not is_backup_path_configured(settings):
            logger.error("Backup settings not found or invalid")
            return BackupResult(status="failed", error="invalid_settings")

        _, container_backup_path = resolve_backup_paths(settings.backup_path)
        backup_service = BackupService(container_backup_path)

        backups = backup_service.list_backups()
        parent_backup_path = None
        backup_type = "full"

        if backups:
            parent_backup_path = Path(backups[0]["backup_path"])
            backup_type = "incremental"

        backup_name = f"backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        backup_path = Path(container_backup_path) / backup_name

        backup_record = models.BackupRecord(
            backup_path=str(backup_path),
            backup_type=backup_type,
            status="in_progress",
            started_at=datetime.utcnow(),
        )
        if parent_backup_path:
            parent_record = (
                db.query(models.BackupRecord)
                .filter(models.BackupRecord.backup_path == str(parent_backup_path))
                .first()
            )
            if parent_record:
                backup_record.parent_backup_id = parent_record.id

        db.add(backup_record)
        db.commit()
        db.refresh(backup_record)

        try:
            projects_dir = get_projects_dir()
            files_ok = False
            file_stats: dict = {}
            if projects_dir.exists():
                _, file_stats = backup_service.create_incremental_backup(
                    projects_dir,
                    backup_name,
                    parent_backup_path,
                )
                backup_record.file_count = file_stats.get("total_files", 0)
                files_ok = True
                backup_record.files_backed_up = True
            else:
                backup_record.files_backed_up = False
                logger.warning("Projects directory not found")
                _ensure_backup_metadata_file(
                    backup_path,
                    backup_name,
                    parent_backup_path=parent_backup_path,
                )

            logger.info(f"Starting database backup to: {backup_path}")
            db_ok = backup_service.backup_database(SQLALCHEMY_DATABASE_URL, backup_path)
            backup_record.database_backed_up = db_ok
            if not db_ok:
                logger.error("Database backup failed - check logs for details")
            else:
                logger.info(
                    f"Database backup completed successfully in: {backup_path / 'database'}"
                )

            if backup_path.exists():
                backup_record.total_size_bytes = sum(
                    f.stat().st_size for f in backup_path.rglob("*") if f.is_file()
                )

            deleted_backups = backup_service.cleanup_old_backups(settings.retention_days)
            if deleted_backups:
                logger.info(f"Deleted {len(deleted_backups)} old backups")

            backup_record.status = _compute_backup_status(files_ok, db_ok)
            backup_record.completed_at = datetime.utcnow()
            backup_record.backup_metadata = {
                "file_stats": file_stats if files_ok else {},
                "deleted_backups": deleted_backups,
                "database_backed_up": db_ok,
                "files_backed_up": backup_record.files_backed_up,
            }

            logger.info(f"Backup {backup_name}: status={backup_record.status}")
            logger.info(f"  - Files: {backup_record.files_backed_up}")
            logger.info(f"  - Database: {db_ok}")
            logger.info(f"  - Location: {backup_path}")

            settings.last_backup_at = datetime.utcnow()
            if settings.enabled:
                settings.next_backup_at = compute_next_backup_at(
                    settings, from_time=settings.last_backup_at
                )
            db.commit()

            return BackupResult(
                backup_id=backup_record.id,
                backup_path=str(backup_path),
                status=backup_record.status,
            )

        except Exception as e:
            logger.error(f"Backup failed: {e}", exc_info=True)
            backup_record.status = "failed"
            backup_record.error_message = str(e)
            backup_record.completed_at = datetime.utcnow()
            db.commit()
            return BackupResult(
                backup_id=backup_record.id,
                backup_path=str(backup_path),
                status="failed",
                error=str(e),
            )

    except Exception as e:
        logger.error(f"Backup task failed: {e}", exc_info=True)
        return BackupResult(status="failed", error=str(e))
    finally:
        db.close()


@dataclass
class RestoreResult:
    success: bool
    status: str = "failed"
    error: Optional[str] = None
    rollback_path: Optional[str] = None
    database_restored: bool = False
    files_restored: bool = False


def run_restore(
    backup_record_id: int,
    *,
    restore_database: bool = True,
    restore_files: bool = True,
) -> RestoreResult:
    """Restore from an auto-backup snapshot."""
    db = SessionLocal()
    try:
        backup_record = (
            db.query(models.BackupRecord)
            .filter(models.BackupRecord.id == backup_record_id)
            .first()
        )
        if not backup_record:
            return RestoreResult(success=False, error="backup_not_found")

        if backup_record.status not in ("completed", "partial"):
            return RestoreResult(
                success=False,
                error=f"backup_status_{backup_record.status}",
            )

        if has_in_progress_backup(db):
            return RestoreResult(success=False, error="backup_in_progress")

        backup_dir = Path(backup_record.backup_path)
        if not backup_dir.exists():
            return RestoreResult(success=False, error="backup_path_missing")

        service = BackupService(str(backup_dir.parent))
        validation = service.validate_snapshot(backup_dir)

        if restore_database and not validation.get("can_restore_database"):
            return RestoreResult(success=False, error="database_dump_missing")
        if restore_files and not validation.get("can_restore_files"):
            return RestoreResult(success=False, error="project_files_missing")

        original_status = backup_record.status
        db_ok = False
        files_ok = False
        rollback_path = None
        errors: list[str] = []

        try:
            if restore_database:
                db_ok, db_err = service.restore_database(
                    backup_dir, SQLALCHEMY_DATABASE_URL
                )
                if not db_ok and db_err:
                    errors.append(db_err)

            if restore_files:
                target = get_projects_dir()
                files_ok, rollback_path, file_err = service.restore_projects(
                    backup_dir, target
                )
                if not files_ok and file_err:
                    errors.append(file_err)

            if restore_database and restore_files:
                success = db_ok and files_ok
            elif restore_database:
                success = db_ok
            else:
                success = files_ok

            backup_record.backup_metadata = {
                **(backup_record.backup_metadata or {}),
                "last_restore_at": datetime.utcnow().isoformat(),
                "restore_database": restore_database,
                "restore_files": restore_files,
                "database_restored": db_ok,
                "files_restored": files_ok,
                "rollback_path": rollback_path,
                "last_restore_success": success,
                "last_restore_error": "; ".join(errors) if errors else None,
            }
            backup_record.status = original_status
            db.commit()

            return RestoreResult(
                success=success,
                status="completed" if success else "failed",
                error="; ".join(errors) if errors else None,
                rollback_path=rollback_path,
                database_restored=db_ok,
                files_restored=files_ok,
            )

        except Exception as e:
            logger.error(f"Restore failed: {e}", exc_info=True)
            backup_record.status = original_status
            backup_record.backup_metadata = {
                **(backup_record.backup_metadata or {}),
                "last_restore_at": datetime.utcnow().isoformat(),
                "last_restore_success": False,
                "last_restore_error": str(e),
            }
            db.commit()
            return RestoreResult(success=False, error=str(e))

    finally:
        db.close()
