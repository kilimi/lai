"""Dataset lifecycle orchestration (duplication, move, dispatch)."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import models
from app.services.dataset_paths import (
    apply_storage_url_rewrite_for_project_move,
    filesystem_relocate_dataset_tree,
)
from app.task_dispatch import ensure_inline_dispatch_allowed

logger = logging.getLogger(__name__)


def create_duplication_task(
    db: Session,
    original_dataset: models.Dataset,
    dataset_id: int,
) -> models.Task:
    """Create a pending ``Task`` row for dataset duplication."""
    task = models.Task(
        name=f"Duplicate Dataset: {original_dataset.name}",
        description=(
            f"Duplicating dataset '{original_dataset.name}' with all images, "
            "annotations, and metadata"
        ),
        task_type="dataset_duplication",
        status="pending",
        project_id=original_dataset.project_id,
        progress=0.0,
        task_metadata={
            "dataset_id": dataset_id,
            "dataset_name": original_dataset.name,
        },
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def dispatch_dataset_duplication(
    db: Session,
    task: models.Task,
    dataset_id: int,
    *,
    use_celery: bool,
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """
    Start duplication on Celery or inline (dev-only).

    Returns ``("async", None)`` for Celery, or ``("inline", result_dict)`` for sync run.
    """
    from app.tasks.dataset_tasks import duplicate_dataset_task

    if use_celery:
        celery_task = duplicate_dataset_task.delay(task.id, dataset_id)
        task.task_metadata = {
            **(task.task_metadata or {}),
            "celery_task_id": celery_task.id,
        }
        db.commit()
        logger.info("Queued dataset duplication task %s (celery_id=%s)", task.id, celery_task.id)
        return "async", None

    ensure_inline_dispatch_allowed("Dataset duplication")
    result = duplicate_dataset_task(task.id, dataset_id)
    return "inline", result


def move_dataset_to_project(
    db: Session,
    dataset: models.Dataset,
    *,
    target_project_id: int,
) -> models.Dataset:
    """
    Move dataset to another project (DB + URLs + filesystem tree when present).
    """
    old_project_id = dataset.project_id
    new_project_id = int(target_project_id)
    moved_id = int(dataset.id)

    if old_project_id == new_project_id:
        return dataset

    target = db.query(models.Project).filter(models.Project.id == new_project_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target project not found")

    filesystem_moved = False
    if old_project_id is not None:
        did_move, fs_err = filesystem_relocate_dataset_tree(
            int(old_project_id), new_project_id, moved_id
        )
        if fs_err:
            code = 409 if "already exists" in fs_err.lower() else 500
            raise HTTPException(status_code=code, detail=fs_err)
        filesystem_moved = bool(did_move)

    try:
        dataset.project_id = new_project_id
        dataset.updated_at = datetime.utcnow()

        if old_project_id is not None:
            apply_storage_url_rewrite_for_project_move(
                db,
                dataset,
                dataset_id=moved_id,
                old_project_id=int(old_project_id),
                new_project_id=new_project_id,
            )
            groups = (
                db.query(models.DatasetGroup)
                .filter(models.DatasetGroup.project_id == old_project_id)
                .all()
            )
            for group in groups:
                ids = group.datasets_list or []
                if moved_id in ids:
                    group.datasets_list = [x for x in ids if int(x) != moved_id]

        db.commit()
        db.refresh(dataset)
        return dataset
    except Exception as exc:
        db.rollback()
        if filesystem_moved and old_project_id is not None:
            rev_ok, rev_err = filesystem_relocate_dataset_tree(
                new_project_id, int(old_project_id), moved_id
            )
            if rev_err or not rev_ok:
                logger.critical(
                    "Dataset move DB failed after FS relocate (dataset_id=%s): %s reverse=%s",
                    moved_id,
                    exc,
                    rev_err,
                )
        logger.exception("move_dataset_to_project failed")
        raise HTTPException(status_code=500, detail=f"Failed to move dataset: {exc}") from exc


def duplication_started_response(task: models.Task) -> Dict[str, Any]:
    """Standard API payload after async duplication is queued."""
    return {
        "success": True,
        "task_id": task.id,
        "message": "Dataset duplication started in background",
        "task": {
            "id": task.id,
            "name": task.name,
            "status": task.status,
            "progress": task.progress,
        },
    }
