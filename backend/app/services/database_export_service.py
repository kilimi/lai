"""Database export orchestration (JSON / ZIP) for Celery workers."""
from __future__ import annotations

import json
import logging
import math
import os
import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

from sqlalchemy.orm import Session

from app import models
from app.database import SessionLocal

logger = logging.getLogger(__name__)

ProgressFn = Callable[[float, str, Optional[Dict[str, Any]]], None]

EXPORTS_ROOT = Path(os.environ.get("LAI_EXPORTS_DIR", "/app/backups/exports"))


def serialize_model(obj: Any) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for column in obj.__table__.columns:
        value = getattr(obj, column.name)
        if isinstance(value, datetime):
            result[column.name] = value.isoformat()
        elif isinstance(value, bytes):
            result[column.name] = value.hex() if value else None
        elif isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            result[column.name] = None
        else:
            result[column.name] = value
    return result


def get_exports_root() -> Path:
    root = EXPORTS_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root


def export_headers(filename: str, *, content_length: Optional[int] = None) -> Dict[str, str]:
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    if content_length is not None:
        headers["Content-Length"] = str(content_length)
    return headers


def _model_map() -> Dict[str, type]:
    return {
        "projects": models.Project,
        "datasets": models.Dataset,
        "image_collections": models.ImageCollection,
        "images": models.Image,
        "annotation_files": models.AnnotationFile,
        "annotation_classes": models.AnnotationClass,
        "annotations": models.Annotation,
        "tasks": models.Task,
        "augmentations": models.Augmentation,
        "dataset_groups": models.DatasetGroup,
    }


def _table_export_order() -> List[str]:
    return [
        "projects",
        "datasets",
        "image_collections",
        "images",
        "annotation_files",
        "annotation_classes",
        "annotations",
        "tasks",
        "augmentations",
        "dataset_groups",
    ]


def _apply_export_filters(
    query,
    model_class,
    table_name: str,
    project_id_list: Optional[List[int]],
    dataset_id_list: Optional[List[int]],
):
    if project_id_list:
        if table_name == "projects":
            query = query.filter(model_class.id.in_(project_id_list))
        elif table_name in ("datasets", "tasks", "dataset_groups"):
            query = query.filter(model_class.project_id.in_(project_id_list))
    if dataset_id_list:
        if table_name == "datasets":
            query = query.filter(model_class.id.in_(dataset_id_list))
        elif table_name in (
            "images",
            "image_collections",
            "annotation_files",
            "annotation_classes",
            "annotations",
        ):
            query = query.filter(model_class.dataset_id.in_(dataset_id_list))
    return query


def generate_json_stream(
    project_id_list: Optional[List[int]],
    dataset_id_list: Optional[List[int]],
) -> Iterator[bytes]:
    db = SessionLocal()
    try:
        yield b'{"metadata":{"export_date":"'
        yield datetime.utcnow().isoformat().encode("utf-8")
        yield b'","version":"1.0","description":"AI Data Creator Database Backup"},"data":{'

        model_map = _model_map()
        first_table = True
        for table_name in _table_export_order():
            try:
                if not first_table:
                    yield b","
                first_table = False

                yield f'"{table_name}":['.encode("utf-8")
                model_class = model_map.get(table_name)

                record_count = 0
                if model_class:
                    query = db.query(model_class)
                    query = _apply_export_filters(
                        query, model_class, table_name, project_id_list, dataset_id_list
                    )

                    first_record = True
                    for record in query.yield_per(500):
                        if not first_record:
                            yield b","
                        first_record = False
                        record_dict = serialize_model(record)
                        yield json.dumps(
                            record_dict,
                            ensure_ascii=False,
                            allow_nan=False,
                            default=str,
                        ).encode("utf-8")
                        record_count += 1
                        if record_count % 1000 == 0:
                            logger.info("  Streamed %s records from %s...", record_count, table_name)

                    logger.info("Streamed %s records from %s", record_count, table_name)

                yield b"]"
            except Exception as e:
                logger.error("Error streaming table %s: %s", table_name, e)
                yield b"]"

        yield b"}}"
    finally:
        db.close()


def write_json_export_file(
    dest: Path,
    project_id_list: Optional[List[int]],
    dataset_id_list: Optional[List[int]],
) -> None:
    with open(dest, "wb") as f:
        for chunk in generate_json_stream(project_id_list, dataset_id_list):
            f.write(chunk)


def _should_include_project_file(
    project_file: Path,
    project_id_list: Optional[List[int]],
) -> bool:
    if not project_id_list:
        return True
    parts = project_file.parts
    if len(parts) < 2:
        return True
    folder = parts[1]
    if not folder.isdigit():
        return False
    return int(folder) in project_id_list


def _iter_export_files(
    project_id_list: Optional[List[int]],
) -> List[Path]:
    files: List[Path] = []
    projects_dir = Path("projects")
    if projects_dir.exists():
        for project_file in projects_dir.rglob("*"):
            if project_file.is_file() and _should_include_project_file(project_file, project_id_list):
                files.append(project_file)
    data_dir = Path("data")
    if data_dir.exists():
        for data_file in data_dir.rglob("*"):
            if data_file.is_file():
                files.append(data_file)
    return files


def build_export_zip_on_disk(
    work_dir: Path,
    project_id_list: Optional[List[int]],
    dataset_id_list: Optional[List[int]],
    *,
    on_progress: Optional[ProgressFn] = None,
) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    db_file = work_dir / "database.json"

    if on_progress:
        on_progress(10.0, "database", None)
    write_json_export_file(db_file, project_id_list, dataset_id_list)

    if on_progress:
        on_progress(35.0, "files", {"message": "Adding project files to archive"})

    zip_path = work_dir / f"lai_full_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.zip"
    export_files = _iter_export_files(project_id_list)
    total_files = len(export_files)
    file_count = 0

    with zipfile.ZipFile(
        zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1
    ) as zip_file:
        zip_file.write(db_file, "database.json")

        for path in export_files:
            arcname = str(path.relative_to("."))
            zip_file.write(path, arcname)
            file_count += 1
            if on_progress and total_files:
                pct = 35.0 + (file_count / total_files) * 60.0
                if file_count % 100 == 0 or file_count == total_files:
                    on_progress(
                        min(95.0, pct),
                        "files",
                        {
                            "files_done": file_count,
                            "files_total": total_files,
                        },
                    )

    try:
        db_file.unlink(missing_ok=True)
    except OSError:
        pass

    logger.info("Created export ZIP (%s bytes, %s files)", zip_path.stat().st_size, file_count)
    return zip_path


def has_in_progress_database_export(db: Session) -> bool:
    return (
        db.query(models.Task)
        .filter(
            models.Task.task_type == "database_export",
            models.Task.status.in_(["pending", "running"]),
        )
        .first()
        is not None
    )


def run_database_export(task_id: int) -> None:
    """Execute database export job (JSON or ZIP) and update Task progress."""
    db = SessionLocal()
    try:
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            logger.error("database_export task %s not found", task_id)
            return

        meta = dict(task.task_metadata or {})
        include_files = bool(meta.get("include_files"))
        project_ids = meta.get("project_ids")
        dataset_ids = meta.get("dataset_ids")

        def report(progress: float, stage: str, extra: Optional[Dict[str, Any]] = None) -> None:
            task.progress = round(min(99.0, max(0.0, progress)), 1)
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": stage,
                **(extra or {}),
            }
            db.commit()

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 5.0
        task.task_metadata = {**meta, "stage": "preparing", "celery_task_id": meta.get("celery_task_id")}
        db.commit()

        work_dir = get_exports_root() / str(task_id)
        work_dir.mkdir(parents=True, exist_ok=True)

        if include_files:
            zip_path = build_export_zip_on_disk(
                work_dir,
                project_ids,
                dataset_ids,
                on_progress=report,
            )
            exported_file = zip_path
            export_format = "zip"
            download_name = zip_path.name
        else:
            report(20.0, "database", None)
            json_path = work_dir / f"lai_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
            write_json_export_file(json_path, project_ids, dataset_ids)
            exported_file = json_path
            export_format = "json"
            download_name = json_path.name
            report(90.0, "finalizing", None)

        task.status = "completed"
        task.progress = 100.0
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **meta,
            "stage": "completed",
            "export_format": export_format,
            "exported_file": str(exported_file.resolve()),
            "download_filename": download_name,
            "exported_file_url": f"/database/export/download/{task_id}",
        }
        db.commit()
        logger.info("database_export task %s completed: %s", task_id, exported_file)

    except Exception as exc:
        logger.error("database_export task %s failed: %s", task_id, exc, exc_info=True)
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if task:
            task.status = "failed"
            task.error_message = str(exc)
            task.completed_at = datetime.utcnow()
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "failed",
            }
            db.commit()
    finally:
        db.close()


def resolve_export_file(task: models.Task) -> Path:
    meta = task.task_metadata or {}
    exported = meta.get("exported_file")
    if not exported:
        raise FileNotFoundError("Export file path missing from task metadata")
    path = Path(exported)
    if not path.is_file():
        raise FileNotFoundError(f"Export file not found: {path}")
    return path
