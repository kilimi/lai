"""
Backup service for incremental backups of database and physical files.
Uses rsync-like approach: only copies changed files, uses hard links for unchanged files.
"""
import os
import shutil
import hashlib
import subprocess
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
import json
import logging

logger = logging.getLogger(__name__)


def parse_postgres_url(db_url: str) -> Optional[Dict[str, str]]:
    """Parse postgresql:// URL into connection components."""
    if not db_url.startswith("postgresql://"):
        return None

    db_url_clean = db_url.replace("postgresql://", "")
    if "@" in db_url_clean:
        auth, host_db = db_url_clean.split("@", 1)
        if ":" in auth:
            user, password = auth.split(":", 1)
        else:
            user = auth
            password = None
    else:
        user = "postgres"
        password = None
        host_db = db_url_clean

    if "/" in host_db:
        host_port, database = host_db.split("/", 1)
    else:
        host_port = host_db
        database = None

    if ":" in host_port:
        host, port = host_port.split(":")
    else:
        host = host_port
        port = "5432"

    return {
        "user": user,
        "password": password or "",
        "host": host,
        "port": port,
        "database": database or "",
    }


class BackupService:
    """Service for creating incremental backups like ZFS snapshots"""
    
    def __init__(self, backup_base_path: str):
        self.backup_base_path = Path(backup_base_path)
        self.backup_base_path.mkdir(parents=True, exist_ok=True)
    
    def get_file_hash(self, file_path: Path) -> str:
        """Calculate SHA256 hash of a file"""
        sha256 = hashlib.sha256()
        try:
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(4096), b''):
                    sha256.update(chunk)
            return sha256.hexdigest()
        except Exception as e:
            logger.error(f"Error calculating hash for {file_path}: {e}")
            return ""
    
    def get_file_metadata(self, file_path: Path) -> Dict:
        """Get file metadata (size, mtime, hash)"""
        try:
            stat = file_path.stat()
            return {
                'size': stat.st_size,
                'mtime': stat.st_mtime,
                'hash': self.get_file_hash(file_path)
            }
        except Exception as e:
            logger.error(f"Error getting metadata for {file_path}: {e}")
            return {}
    
    def find_all_files(self, source_dir: Path) -> List[Path]:
        """Find all files in source directory"""
        files = []
        if not source_dir.exists():
            return files
        
        for root, dirs, filenames in os.walk(source_dir):
            # Skip hidden directories and backup directories
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != 'backups']
            for filename in filenames:
                if not filename.startswith('.'):
                    files.append(Path(root) / filename)
        return files
    
    def create_incremental_backup(
        self,
        source_dir: Path,
        backup_name: str,
        parent_backup_path: Optional[Path] = None
    ) -> Tuple[Path, Dict]:
        """
        Create an incremental backup.
        - If parent_backup exists, only copy changed/new files
        - Use hard links for unchanged files (saves space)
        - Returns backup path and statistics
        """
        backup_path = self.backup_base_path / backup_name
        backup_path.mkdir(parents=True, exist_ok=True)
        
        stats = {
            'total_files': 0,
            'copied_files': 0,
            'linked_files': 0,
            'skipped_files': 0,
            'total_size': 0,
            'copied_size': 0,
            'errors': []
        }
        
        # Load parent backup manifest if it exists
        parent_manifest = {}
        if parent_backup_path and parent_backup_path.exists():
            manifest_file = parent_backup_path / '.backup_manifest.json'
            if manifest_file.exists():
                try:
                    with open(manifest_file, 'r') as f:
                        parent_manifest = json.load(f)
                except Exception as e:
                    logger.warning(f"Could not load parent manifest: {e}")
        
        # Create manifest for this backup
        current_manifest = {}
        
        # Find all source files
        source_files = self.find_all_files(source_dir)
        stats['total_files'] = len(source_files)
        
        for source_file in source_files:
            try:
                # Get relative path from source_dir
                try:
                    rel_path = source_file.relative_to(source_dir)
                except ValueError:
                    # File is outside source_dir, skip
                    stats['skipped_files'] += 1
                    continue
                
                dest_file = backup_path / rel_path
                dest_file.parent.mkdir(parents=True, exist_ok=True)
                
                # Get current file metadata
                file_meta = self.get_file_metadata(source_file)
                if not file_meta:
                    stats['skipped_files'] += 1
                    continue
                
                stats['total_size'] += file_meta['size']
                
                # Check if file exists in parent backup and is unchanged
                file_key = str(rel_path)
                if file_key in parent_manifest:
                    parent_meta = parent_manifest[file_key]
                    # Check if file is unchanged (same hash)
                    if (file_meta.get('hash') == parent_meta.get('hash') and
                        file_meta.get('size') == parent_meta.get('size')):
                        # File unchanged - try to create hard link from parent backup
                        parent_file = parent_backup_path / rel_path
                        if parent_file.exists():
                            try:
                                # Try to create hard link
                                os.link(str(parent_file), str(dest_file))
                                stats['linked_files'] += 1
                                current_manifest[file_key] = file_meta
                                continue
                            except (OSError, AttributeError):
                                # Hard link failed (different filesystem, etc.) - fall back to copy
                                pass
                
                # File is new or changed - copy it
                shutil.copy2(source_file, dest_file)
                stats['copied_files'] += 1
                stats['copied_size'] += file_meta['size']
                current_manifest[file_key] = file_meta
                
            except Exception as e:
                error_msg = f"Error backing up {source_file}: {e}"
                logger.error(error_msg)
                stats['errors'].append(error_msg)
                stats['skipped_files'] += 1
        
        # Save manifest
        manifest_file = backup_path / '.backup_manifest.json'
        with open(manifest_file, 'w') as f:
            json.dump(current_manifest, f, indent=2)
        
        # Save backup metadata
        metadata_file = backup_path / '.backup_metadata.json'
        with open(metadata_file, 'w') as f:
            json.dump({
                'backup_name': backup_name,
                'created_at': datetime.utcnow().isoformat(),
                'source_dir': str(source_dir),
                'parent_backup': str(parent_backup_path) if parent_backup_path else None,
                'stats': stats
            }, f, indent=2)
        
        return backup_path, stats
    
    def backup_database(self, db_url: str, backup_path: Path) -> bool:
        """
        Backup PostgreSQL database using pg_dump.
        Returns True if successful.
        """
        try:
            conn = parse_postgres_url(db_url)
            if not conn:
                logger.error(f"Unsupported database type: {db_url}")
                return False

            user = conn["user"]
            password = conn["password"] or None
            host = conn["host"]
            port = conn["port"]
            database = conn["database"] or None
            
            # Create database backup directory
            db_backup_dir = Path(backup_path) / 'database'
            db_backup_dir.mkdir(parents=True, exist_ok=True)
            
            # Use pg_dump to create backup (custom format for better compression and restore)
            dump_file = db_backup_dir / f'database_{datetime.utcnow().strftime("%Y%m%d_%H%M%S")}.dump'
            
            logger.info(f"Creating database backup: {dump_file}")
            logger.info(f"Connecting to: {host}:{port}, database: {database}, user: {user}")
            
            # Build pg_dump command
            cmd = ['pg_dump', '-h', host, '-p', port, '-U', user, '-F', 'c', '-f', str(dump_file)]
            if database:
                cmd.extend(['-d', database])
            
            # Set PGPASSWORD environment variable if password provided
            env = os.environ.copy()
            if password:
                env['PGPASSWORD'] = password
            
            # Run pg_dump
            result = subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=3600  # 1 hour timeout
            )
            
            if result.returncode == 0:
                logger.info(f"Database backup created successfully: {dump_file}")
                # Verify file was created and has content
                if dump_file.exists() and dump_file.stat().st_size > 0:
                    logger.info(f"Database backup file size: {dump_file.stat().st_size} bytes")
                    return True
                else:
                    logger.error(f"Database backup file was created but is empty or missing: {dump_file}")
                    return False
            else:
                logger.error(f"pg_dump failed with return code {result.returncode}")
                logger.error(f"pg_dump stderr: {result.stderr}")
                logger.error(f"pg_dump stdout: {result.stdout}")
                return False
                
        except subprocess.TimeoutExpired:
            logger.error("Database backup timed out")
            return False
        except Exception as e:
            logger.error(f"Database backup failed: {e}")
            return False
    
    def cleanup_old_backups(self, retention_days: int) -> List[str]:
        """Delete backups older than retention_days"""
        deleted = []
        cutoff_date = datetime.utcnow() - timedelta(days=retention_days)
        
        if not self.backup_base_path.exists():
            return deleted
        
        for backup_dir in self.backup_base_path.iterdir():
            if not backup_dir.is_dir():
                continue
            
            # Check backup metadata for creation date
            metadata_file = backup_dir / '.backup_metadata.json'
            if metadata_file.exists():
                try:
                    with open(metadata_file, 'r') as f:
                        metadata = json.load(f)
                    created_at_str = metadata.get('created_at')
                    if created_at_str:
                        created_at = datetime.fromisoformat(created_at_str.replace('Z', '+00:00'))
                        if created_at.replace(tzinfo=None) < cutoff_date:
                            # Backup is old, delete it
                            shutil.rmtree(backup_dir)
                            deleted.append(str(backup_dir))
                            logger.info(f"Deleted old backup: {backup_dir}")
                except Exception as e:
                    logger.warning(f"Could not read metadata for {backup_dir}: {e}")
                    # If we can't read metadata, check directory modification time
                    mtime = datetime.fromtimestamp(backup_dir.stat().st_mtime)
                    if mtime < cutoff_date:
                        shutil.rmtree(backup_dir)
                        deleted.append(str(backup_dir))
        
        return deleted
    
    def get_backup_info(self, backup_path: Path) -> Optional[Dict]:
        """Get information about a backup"""
        metadata_file = backup_path / '.backup_metadata.json'
        if not metadata_file.exists():
            return None
        
        try:
            with open(metadata_file, 'r') as f:
                metadata = json.load(f)
            
            # Get actual size on disk
            total_size = sum(
                f.stat().st_size for f in backup_path.rglob('*') if f.is_file()
            )
            
            metadata['actual_size_bytes'] = total_size
            metadata['backup_path'] = str(backup_path)
            return metadata
        except Exception as e:
            logger.error(f"Error reading backup info: {e}")
            return None
    
    def list_backups(self) -> List[Dict]:
        """List all backups with their information"""
        backups = []
        
        if not self.backup_base_path.exists():
            return backups
        
        for backup_dir in sorted(self.backup_base_path.iterdir(), reverse=True):
            if not backup_dir.is_dir() or backup_dir.name.startswith('.'):
                continue
            
            info = self.get_backup_info(backup_dir)
            if info:
                backups.append(info)
        
        return backups

    def find_database_dump(self, backup_dir: Path) -> Optional[Path]:
        """Find the latest pg_dump file in a snapshot."""
        db_dir = backup_dir / "database"
        if not db_dir.is_dir():
            return None
        dumps = sorted(db_dir.glob("*.dump"), reverse=True)
        for dump in dumps:
            if dump.is_file() and dump.stat().st_size > 0:
                return dump
        return None

    def _projects_source_in_snapshot(self, backup_dir: Path) -> Optional[Path]:
        """Locate project files inside a snapshot directory."""
        projects_sub = backup_dir / "projects"
        if projects_sub.is_dir() and any(projects_sub.iterdir()):
            return projects_sub

        skip_names = {"database", ".backup_manifest.json", ".backup_metadata.json"}
        has_files = False
        for child in backup_dir.iterdir():
            if child.name.startswith(".") or child.name in skip_names:
                continue
            has_files = True
            break
        if has_files:
            return backup_dir
        return None

    def validate_snapshot(self, backup_dir: Path) -> Dict:
        """Return readiness flags for restoring a snapshot."""
        backup_dir = Path(backup_dir)
        dump = self.find_database_dump(backup_dir)
        projects_src = self._projects_source_in_snapshot(backup_dir)
        manifest_ok = (backup_dir / ".backup_manifest.json").exists()

        return {
            "backup_path": str(backup_dir),
            "has_database_dump": dump is not None,
            "has_project_files": projects_src is not None,
            "has_manifest": manifest_ok,
            "can_restore_database": dump is not None,
            "can_restore_files": projects_src is not None,
            "database_dump_path": str(dump) if dump else None,
            "projects_source_path": str(projects_src) if projects_src else None,
        }

    def restore_database(self, backup_dir: Path, db_url: str) -> Tuple[bool, Optional[str]]:
        """Restore PostgreSQL from pg_dump custom format. Returns (success, error)."""
        dump_file = self.find_database_dump(Path(backup_dir))
        if not dump_file:
            return False, "No database dump found in snapshot"

        conn = parse_postgres_url(db_url)
        if not conn:
            return False, "Unsupported database URL"

        cmd = [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-acl",
            "-h",
            conn["host"],
            "-p",
            conn["port"],
            "-U",
            conn["user"],
            "-d",
            conn["database"],
            str(dump_file),
        ]

        env = os.environ.copy()
        if conn["password"]:
            env["PGPASSWORD"] = conn["password"]

        logger.info(f"Restoring database from {dump_file}")
        try:
            result = subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=3600,
            )
            stderr = result.stderr or ""
            if result.returncode != 0 and "error" in stderr.lower():
                logger.error(f"pg_restore failed: {stderr}")
                return False, stderr.strip() or f"pg_restore exit code {result.returncode}"
            if result.returncode != 0:
                logger.warning(f"pg_restore warnings (exit {result.returncode}): {stderr}")
            logger.info("Database restore completed")
            return True, None
        except subprocess.TimeoutExpired:
            return False, "Database restore timed out"
        except Exception as e:
            logger.error(f"Database restore failed: {e}")
            return False, str(e)

    def restore_projects(
        self, backup_dir: Path, target_dir: Path
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Restore project files from snapshot.
        Returns (success, rollback_path, error).
        """
        backup_dir = Path(backup_dir)
        target_dir = Path(target_dir)
        source = self._projects_source_in_snapshot(backup_dir)
        if not source:
            return False, None, "No project files found in snapshot"

        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        rollback_path = None

        try:
            if target_dir.exists() and any(target_dir.iterdir()):
                rollback_path = str(
                    target_dir.parent / f"{target_dir.name}.pre_restore_{timestamp}"
                )
                logger.info(f"Renaming current projects to {rollback_path}")
                target_dir.rename(rollback_path)

            target_dir.mkdir(parents=True, exist_ok=True)

            skip_names = {"database", ".backup_manifest.json", ".backup_metadata.json"}

            def should_copy(rel: Path) -> bool:
                parts = rel.parts
                if not parts:
                    return False
                if parts[0] in skip_names or parts[0].startswith("."):
                    return False
                return True

            if source == backup_dir:
                for item in source.iterdir():
                    if item.name in skip_names or item.name.startswith("."):
                        continue
                    dest = target_dir / item.name
                    if item.is_dir():
                        shutil.copytree(item, dest, dirs_exist_ok=True)
                    else:
                        shutil.copy2(item, dest)
            else:
                for root, dirs, files in os.walk(source):
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    root_path = Path(root)
                    for filename in files:
                        if filename.startswith("."):
                            continue
                        src_file = root_path / filename
                        rel = src_file.relative_to(source)
                        if not should_copy(rel):
                            continue
                        dest_file = target_dir / rel
                        dest_file.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(src_file, dest_file)

            logger.info(f"Project files restored to {target_dir}")
            return True, rollback_path, None

        except Exception as e:
            logger.error(f"Project restore failed: {e}", exc_info=True)
            return False, rollback_path, str(e)
