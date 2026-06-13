from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import text
import json
import io
import zipfile
import os
import shutil
import tempfile
import math
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Iterator, Optional
import logging

from pydantic import BaseModel
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from .. import models
from ..database import get_db, engine, SessionLocal
from ..services.database_export_service import (
    export_headers,
    generate_json_stream,
    build_export_zip_on_disk,
    has_in_progress_database_export,
    resolve_export_file,
    run_database_export,
)
from ..task_dispatch import ensure_inline_dispatch_allowed, use_celery_enabled

logger = logging.getLogger(__name__)

router = APIRouter()

def serialize_model(obj: Any) -> Dict[str, Any]:
    """Convert SQLAlchemy model to dictionary"""
    result = {}
    for column in obj.__table__.columns:
        value = getattr(obj, column.name)
        if isinstance(value, datetime):
            result[column.name] = value.isoformat()
        elif isinstance(value, bytes):
            # Handle binary data (like logos)
            result[column.name] = value.hex() if value else None
        elif isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            # NaN/Infinity are not valid JSON (json.dumps emits bare NaN)
            result[column.name] = None
        else:
            result[column.name] = value
    return result


def _parse_backup_json(raw: bytes, *, source: str) -> Dict[str, Any]:
    """Parse backup JSON with actionable errors for truncated/corrupt exports."""
    try:
        return json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Backup file is not valid UTF-8 ({source}): {exc}",
        ) from exc
    except json.JSONDecodeError as exc:
        pos = exc.pos
        hint = (
            "The backup JSON is corrupted or was cut off during export/download. "
            "Re-export using the full ZIP archive, or export fewer projects/datasets. "
            "Do not use a partial download."
        )
        if pos is not None:
            hint += f" Parse failed near byte {pos}."
        raise HTTPException(status_code=400, detail=f"Invalid backup JSON ({source}): {exc}. {hint}") from exc

def get_all_table_data(db: Session, project_ids: List[int] = None, dataset_ids: List[int] = None) -> Dict[str, List[Dict[str, Any]]]:
    """Export all data from all tables with optional filtering"""
    data = {}
    
    # Define the order of tables to maintain referential integrity during import
    table_order = [
        'projects',
        'datasets', 
        'image_collections',
        'images',
        'annotation_files',
        'annotation_classes',
        'annotations',
        'tasks',
        'augmentations',
        'dataset_groups'
    ]
    
    for table_name in table_order:
        try:
            # Get the model class
            model_class = None
            if table_name == 'projects':
                model_class = models.Project
            elif table_name == 'datasets':
                model_class = models.Dataset
            elif table_name == 'image_collections':
                model_class = models.ImageCollection
            elif table_name == 'images':
                model_class = models.Image
            elif table_name == 'annotation_files':
                model_class = models.AnnotationFile
            elif table_name == 'annotation_classes':
                model_class = models.AnnotationClass
            elif table_name == 'annotations':
                model_class = models.Annotation
            elif table_name == 'tasks':
                model_class = models.Task
            elif table_name == 'augmentations':
                model_class = models.Augmentation
            elif table_name == 'dataset_groups':
                model_class = models.DatasetGroup
            
            if model_class:
                query = db.query(model_class)
                
                # Apply filters
                if project_ids:
                    if table_name == 'projects':
                        query = query.filter(model_class.id.in_(project_ids))
                    elif table_name in ['datasets', 'tasks', 'dataset_groups']:
                        query = query.filter(model_class.project_id.in_(project_ids))
                
                if dataset_ids:
                    if table_name == 'datasets':
                        query = query.filter(model_class.id.in_(dataset_ids))
                    elif table_name in ['images', 'image_collections', 'annotation_files', 'annotation_classes', 'annotations']:
                        query = query.filter(model_class.dataset_id.in_(dataset_ids))
                
                # Use yield_per() to fetch in batches instead of loading all at once
                # This reduces memory usage dramatically for large tables
                records = []
                batch_count = 0
                for record in query.yield_per(1000):
                    records.append(serialize_model(record))
                    batch_count += 1
                    if batch_count % 1000 == 0:
                        logger.info(f"  Processed {batch_count} records from {table_name}...")
                
                data[table_name] = records
                logger.info(f"✓ Exported {len(records)} records from {table_name}")
            
        except Exception as e:
            logger.error(f"Error exporting table {table_name}: {str(e)}")
            data[table_name] = []
    
    return data


class DatabaseExportStartRequest(BaseModel):
    include_files: bool = False
    project_ids: Optional[List[int]] = None
    dataset_ids: Optional[List[int]] = None
    task_name: Optional[str] = None


@router.post("/database/export/start")
async def start_database_export(
    body: DatabaseExportStartRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Start a background database export task (JSON or ZIP)."""
    if has_in_progress_database_export(db):
        raise HTTPException(
            status_code=409,
            detail="A database export is already in progress",
        )

    label = "Complete archive" if body.include_files else "Database JSON"
    task_name = body.task_name or f"{label} {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}"
    export_task = models.Task(
        name=task_name,
        task_type="database_export",
        status="pending",
        progress=0.0,
        task_metadata={
            "include_files": body.include_files,
            "project_ids": body.project_ids,
            "dataset_ids": body.dataset_ids,
            "stage": "queued",
        },
    )
    db.add(export_task)
    db.commit()
    db.refresh(export_task)

    if use_celery_enabled():
        from app.tasks.database_export_tasks import export_database as export_database_task

        celery_result = export_database_task.delay(export_task.id)
        export_task.task_metadata = {
            **(export_task.task_metadata or {}),
            "celery_task_id": celery_result.id,
        }
        db.commit()
    else:
        ensure_inline_dispatch_allowed("Database export")
        background_tasks.add_task(run_database_export, export_task.id)

    return {
        "success": True,
        "task_id": export_task.id,
        "message": "Database export started",
        "data": {
            "task_id": export_task.id,
            "name": export_task.name,
            "status": export_task.status,
        },
    }


@router.get("/database/export/download/{task_id}")
async def download_database_export(task_id: int, db: Session = Depends(get_db)):
    """Download a completed database export file."""
    task = (
        db.query(models.Task)
        .filter(
            models.Task.id == task_id,
            models.Task.task_type == "database_export",
        )
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Export task not found")
    if task.status != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Export is not ready (status={task.status})",
        )

    try:
        path = resolve_export_file(task)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    meta = task.task_metadata or {}
    filename = meta.get("download_filename") or path.name
    export_format = meta.get("export_format", "json")
    media_type = "application/zip" if export_format == "zip" else "application/json"

    return FileResponse(
        path=str(path),
        media_type=media_type,
        filename=filename,
        headers=export_headers(filename, content_length=path.stat().st_size),
    )


@router.get("/database/export")
async def export_database(
    project_ids: str = None,
    dataset_ids: str = None,
):
    """Legacy: stream JSON export. Prefer POST /database/export/start."""
    try:
        logger.info("Starting database export (legacy stream)")
        project_id_list = [int(x) for x in project_ids.split(",")] if project_ids else None
        dataset_id_list = [int(x) for x in dataset_ids.split(",")] if dataset_ids else None

        filename = f"lai_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
        return StreamingResponse(
            iterate_in_threadpool(
                generate_json_stream(project_id_list, dataset_id_list)
            ),
            media_type="application/json",
            headers=export_headers(filename),
        )
    except Exception as e:
        logger.error("Database export failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@router.get("/database/export-with-files")
async def export_database_with_files(
    background_tasks: BackgroundTasks,
    project_ids: str = None,
    dataset_ids: str = None,
):
    """Legacy sync ZIP export. Prefer POST /database/export/start."""
    try:
        logger.info("Starting database export with files (legacy)")
        project_id_list = [int(x) for x in project_ids.split(",")] if project_ids else None
        dataset_id_list = [int(x) for x in dataset_ids.split(",")] if dataset_ids else None

        work_dir = Path(tempfile.mkdtemp(prefix="lai-export-"))
        zip_path = await run_in_threadpool(
            build_export_zip_on_disk,
            work_dir,
            project_id_list,
            dataset_id_list,
        )
        zip_size = zip_path.stat().st_size
        filename = zip_path.name

        def _cleanup(path: Path) -> None:
            try:
                path.unlink(missing_ok=True)
                if path.parent.exists():
                    shutil.rmtree(path.parent, ignore_errors=True)
            except OSError:
                pass

        background_tasks.add_task(_cleanup, zip_path)

        return FileResponse(
            path=str(zip_path),
            media_type="application/zip",
            filename=filename,
            headers=export_headers(filename, content_length=zip_size),
        )
    except Exception as e:
        logger.error("Database export with files failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

def deserialize_model_data(table_name: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert dictionary back to model-compatible format"""
    result = data.copy()
    
    # Handle datetime fields
    datetime_fields = ['created_at', 'updated_at', 'uploaded_at', 'started_at', 'completed_at']
    for field in datetime_fields:
        if field in result and result[field]:
            try:
                result[field] = datetime.fromisoformat(result[field])
            except (ValueError, TypeError):
                result[field] = None
    
    # Handle binary fields (logos)
    if 'logo' in result and result['logo']:
        try:
            result['logo'] = bytes.fromhex(result['logo'])
        except (ValueError, TypeError):
            result['logo'] = None
    
    return result

@router.post("/database/import")
async def import_database(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import database from JSON file (WARNING: This will clear existing data)"""
    try:
        logger.info("Starting database import")
        
        # Read the uploaded file
        content = await file.read()
        
        # Handle ZIP files
        if file.filename.endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(content), 'r') as zip_file:
                # Extract database.json
                if 'database.json' not in zip_file.namelist():
                    raise HTTPException(status_code=400, detail="ZIP file must contain database.json")
                
                # Read database.json from ZIP
                with zip_file.open('database.json') as db_file:
                    import_data = _parse_backup_json(db_file.read(), source="database.json in ZIP")
                
                # Extract other files
                extract_dir = Path("temp_restore")
                extract_dir.mkdir(exist_ok=True)
                
                try:
                    for member in zip_file.namelist():
                        if member != 'database.json' and not member.endswith('/'):
                            # Extract file
                            zip_file.extract(member, extract_dir)
                            
                            # Move to correct location
                            source_path = extract_dir / member
                            target_path = Path(member)
                            target_path.parent.mkdir(parents=True, exist_ok=True)
                            
                            if source_path.exists():
                                shutil.move(str(source_path), str(target_path))
                                logger.info(f"Restored file: {member}")
                
                finally:
                    # Clean up temp directory
                    if extract_dir.exists():
                        shutil.rmtree(extract_dir)
        
        else:
            # Handle JSON files
            import_data = _parse_backup_json(content, source=file.filename or "uploaded JSON")
        
        # Validate import data structure
        if 'data' not in import_data:
            raise HTTPException(status_code=400, detail="Invalid backup file format")
        
        data = import_data['data']
        
        # Clear existing data (in reverse order to maintain referential integrity)
        table_order = [
            'dataset_groups',
            'augmentations', 
            'tasks',
            'annotations',
            'annotation_classes',
            'annotation_files',
            'images',
            'image_collections',
            'datasets',
            'projects'
        ]
        
        for table_name in table_order:
            try:
                # Delete all records from table
                if table_name == 'projects':
                    db.query(models.Project).delete()
                elif table_name == 'datasets':
                    db.query(models.Dataset).delete()
                elif table_name == 'image_collections':
                    db.query(models.ImageCollection).delete()
                elif table_name == 'images':
                    db.query(models.Image).delete()
                elif table_name == 'annotation_files':
                    db.query(models.AnnotationFile).delete()
                elif table_name == 'annotation_classes':
                    db.query(models.AnnotationClass).delete()
                elif table_name == 'annotations':
                    db.query(models.Annotation).delete()
                elif table_name == 'tasks':
                    db.query(models.Task).delete()
                elif table_name == 'augmentations':
                    db.query(models.Augmentation).delete()
                elif table_name == 'dataset_groups':
                    db.query(models.DatasetGroup).delete()
                    
                logger.info(f"Cleared table {table_name}")
            except Exception as e:
                logger.error(f"Error clearing table {table_name}: {str(e)}")
        
        db.commit()
        
        # Insert data (in original order to maintain referential integrity)
        insert_order = [
            'projects',
            'datasets', 
            'image_collections',
            'images',
            'annotation_files',
            'annotation_classes',
            'annotations',
            'tasks',
            'augmentations',
            'dataset_groups'
        ]
        
        for table_name in insert_order:
            if table_name in data and data[table_name]:
                try:
                    for record_data in data[table_name]:
                        # Deserialize the data
                        clean_data = deserialize_model_data(table_name, record_data)
                        
                        # Create model instance
                        if table_name == 'projects':
                            record = models.Project(**clean_data)
                        elif table_name == 'datasets':
                            record = models.Dataset(**clean_data)
                        elif table_name == 'image_collections':
                            record = models.ImageCollection(**clean_data)
                        elif table_name == 'images':
                            record = models.Image(**clean_data)
                        elif table_name == 'annotation_files':
                            record = models.AnnotationFile(**clean_data)
                        elif table_name == 'annotation_classes':
                            record = models.AnnotationClass(**clean_data)
                        elif table_name == 'annotations':
                            record = models.Annotation(**clean_data)
                        elif table_name == 'tasks':
                            record = models.Task(**clean_data)
                        elif table_name == 'augmentations':
                            record = models.Augmentation(**clean_data)
                        elif table_name == 'dataset_groups':
                            record = models.DatasetGroup(**clean_data)
                        
                        db.add(record)
                    
                    db.commit()
                    logger.info(f"Imported {len(data[table_name])} records to {table_name}")
                    
                except Exception as e:
                    db.rollback()
                    logger.error(f"Error importing table {table_name}: {str(e)}")
                    raise HTTPException(status_code=500, detail=f"Import failed at table {table_name}: {str(e)}")
        
        logger.info("Database import completed successfully")
        return {
            "message": "Database imported successfully",
            "metadata": import_data.get("metadata", {}),
            "tables_imported": list(data.keys())
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Database import failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

@router.get("/database/connection")
async def get_database_connection_info():
    """Get database connection information"""
    try:
        from ..database import SQLALCHEMY_DATABASE_URL
        
        # Parse database URL to extract connection details
        # Format: postgresql://user:password@host:port/database
        db_url = SQLALCHEMY_DATABASE_URL
        
        # Extract database name from URL
        db_name = "Unknown"
        db_host = "Unknown"
        db_type = "Unknown"
        
        if db_url:
            try:
                # Simple parsing of database URL
                if db_url.startswith('postgresql://'):
                    db_type = "PostgreSQL"
                    # Extract database name (after last /)
                    db_name = db_url.split('/')[-1]
                    # Extract host (between @ and /)
                    host_part = db_url.split('@')[1].split('/')[0]
                    db_host = host_part.split(':')[0] if ':' in host_part else host_part
                elif db_url.startswith('sqlite:///'):
                    db_type = "SQLite"
                    db_name = db_url.split(':///')[-1]
                    db_host = "local"
            except Exception as parse_error:
                logger.warning(f"Error parsing database URL: {str(parse_error)}")
        
        return {
            "database_name": db_name,
            "database_type": db_type,
            "database_host": db_host,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Failed to get database connection info: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get database connection info: {str(e)}")

@router.get("/database/info")
async def get_database_info(db: Session = Depends(get_db)):
    """Get database statistics using optimized single-query approach"""
    try:
        # Use a single query with UNION ALL to get all counts at once
        # This is MUCH faster than 10 separate COUNT queries
        query = text("""
            SELECT 'projects' as table_name, COUNT(*)::int as count FROM projects
            UNION ALL SELECT 'datasets', COUNT(*)::int FROM datasets
            UNION ALL SELECT 'images', COUNT(*)::int FROM images
            UNION ALL SELECT 'annotations', COUNT(*)::int FROM annotations
            UNION ALL SELECT 'annotation_files', COUNT(*)::int FROM annotation_files
            UNION ALL SELECT 'annotation_classes', COUNT(*)::int FROM annotation_classes
            UNION ALL SELECT 'image_collections', COUNT(*)::int FROM image_collections
            UNION ALL SELECT 'tasks', COUNT(*)::int FROM tasks
            UNION ALL SELECT 'augmentations', COUNT(*)::int FROM augmentations
            UNION ALL SELECT 'dataset_groups', COUNT(*)::int FROM dataset_groups
        """)
        
        result = db.execute(query)
        
        # Build info dictionary from results
        info = {}
        for row in result:
            info[row.table_name] = row.count
        
        # Calculate total
        info['total_records'] = sum(info.values())
        
        return {
            "database_info": info,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Failed to get database info: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get database info: {str(e)}")


@router.delete("/database/clear")
async def clear_database(db: Session = Depends(get_db)):
    """Clear all data from database and remove all physical files (DANGEROUS OPERATION)"""
    try:
        logger.warning("DANGEROUS OPERATION: Starting complete database and file system clear")
        
        # Disable foreign key checks temporarily to avoid constraint issues
        db.execute(text("SET session_replication_role = replica;"))
        
        # Clear database tables in reverse dependency order
        table_order = [
            'dataset_groups',
            'augmentations', 
            'tasks',
            'annotations',
            'annotation_classes',
            'annotation_files',
            'images',
            'image_collections',
            'datasets',
            'projects'
        ]
        
        deleted_counts = {}
        
        for table_name in table_order:
            try:
                # Use a savepoint so a failure here doesn't abort the whole transaction
                db.execute(text(f"SAVEPOINT sp_{table_name}"))
                count_before = 0
                if table_name == 'projects':
                    count_before = db.query(models.Project).count()
                    db.query(models.Project).delete(synchronize_session=False)
                elif table_name == 'datasets':
                    count_before = db.query(models.Dataset).count()
                    db.query(models.Dataset).delete(synchronize_session=False)
                elif table_name == 'image_collections':
                    count_before = db.query(models.ImageCollection).count()
                    db.query(models.ImageCollection).delete(synchronize_session=False)
                elif table_name == 'images':
                    count_before = db.query(models.Image).count()
                    db.query(models.Image).delete(synchronize_session=False)
                elif table_name == 'annotation_files':
                    count_before = db.query(models.AnnotationFile).count()
                    db.query(models.AnnotationFile).delete(synchronize_session=False)
                elif table_name == 'annotation_classes':
                    count_before = db.query(models.AnnotationClass).count()
                    db.query(models.AnnotationClass).delete(synchronize_session=False)
                elif table_name == 'annotations':
                    count_before = db.query(models.Annotation).count()
                    db.query(models.Annotation).delete(synchronize_session=False)
                elif table_name == 'tasks':
                    count_before = db.query(models.Task).count()
                    db.query(models.Task).delete(synchronize_session=False)
                elif table_name == 'augmentations':
                    count_before = db.query(models.Augmentation).count()
                    db.query(models.Augmentation).delete(synchronize_session=False)
                elif table_name == 'dataset_groups':
                    count_before = db.query(models.DatasetGroup).count()
                    db.query(models.DatasetGroup).delete(synchronize_session=False)
                
                db.execute(text(f"RELEASE SAVEPOINT sp_{table_name}"))
                deleted_counts[table_name] = count_before
                logger.info(f"Cleared {count_before} records from {table_name}")
                
            except Exception as e:
                # Roll back only this table's savepoint — transaction stays alive for remaining tables
                try:
                    db.execute(text(f"ROLLBACK TO SAVEPOINT sp_{table_name}"))
                except Exception:
                    pass
                logger.error(f"Error clearing table {table_name}: {str(e)}")
                deleted_counts[table_name] = 0
        
        # Re-enable foreign key checks
        db.execute(text("SET session_replication_role = origin;"))
        
        # Commit database changes
        db.commit()
        
        # Remove all physical files
        files_removed = 0
        dirs_removed = []
        
        # Remove projects directory
        projects_dir = Path("projects")
        if projects_dir.exists():
            try:
                file_count = sum(1 for f in projects_dir.rglob("*") if f.is_file())
                shutil.rmtree(projects_dir)
                projects_dir.mkdir(exist_ok=True)
                files_removed += file_count
                dirs_removed.append("projects")
                logger.info(f"Removed projects directory with {file_count} files")
            except Exception as e:
                logger.error(f"Error removing projects directory: {str(e)}")
        
        # Remove data directory
        data_dir = Path("data")
        if data_dir.exists():
            try:
                file_count = sum(1 for f in data_dir.rglob("*") if f.is_file())
                shutil.rmtree(data_dir)
                data_dir.mkdir(exist_ok=True)
                files_removed += file_count
                dirs_removed.append("data")
                logger.info(f"Removed data directory with {file_count} files")
            except Exception as e:
                logger.error(f"Error removing data directory: {str(e)}")
        
        total_records_deleted = sum(deleted_counts.values())
        
        logger.warning(f"DANGEROUS OPERATION COMPLETED: Deleted {total_records_deleted} database records and {files_removed} files")
        
        return {
            "message": "Database and files cleared successfully",
            "deleted_records": deleted_counts,
            "total_records_deleted": total_records_deleted,
            "files_removed": files_removed,
            "directories_cleared": dirs_removed,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Database clear operation failed: {str(e)}")
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Clear operation failed: {str(e)}")
