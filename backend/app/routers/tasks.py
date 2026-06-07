from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from sqlalchemy.orm.attributes import flag_modified
from typing import Optional, List, Any, Dict
from datetime import datetime, timedelta
import logging
import shutil
from pathlib import Path
from celery import Celery
from pydantic import BaseModel

from .. import models, schemas
from ..database import get_db

router = APIRouter()
logger = logging.getLogger(__name__)

# Initialize Celery app for task control
celery_app = Celery('tasks', broker='redis://redis:6379/0', backend='redis://redis:6379/0')

# Heavy keys omitted from list views (full detail via GET /tasks/{id} or evaluation-blobs).
_LIST_METADATA_RESULT_KEYS_DROP = frozenset(
    {'predictions', 'all_ground_truth', 'confusion_matrix_samples', 'image_id_to_filename'}
)

# Top-level task_metadata keys that can be very large (e.g. full COCO JSON stored inline).
_LIST_METADATA_TOP_KEYS_DROP = frozenset(
    {'coco_data', 'annotations_data', 'images_data'}
)


def _strip_task_metadata_for_list(meta: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not meta or not isinstance(meta, dict):
        return meta
    out = {k: v for k, v in meta.items() if k not in _LIST_METADATA_TOP_KEYS_DROP}
    res = out.get('results')
    if isinstance(res, dict):
        out['results'] = {
            k: v for k, v in res.items() if k not in _LIST_METADATA_RESULT_KEYS_DROP
        }
    return out


def _tasks_to_schema_list(tasks: List[models.Task], metadata_mode: str) -> List[schemas.Task]:
    mode = (metadata_mode or 'full').lower()
    if mode != 'list':
        return [schemas.Task.model_validate(t, from_attributes=True) for t in tasks]
    out: List[schemas.Task] = []
    for t in tasks:
        base = schemas.Task.model_validate(t, from_attributes=True)
        out.append(
            base.model_copy(update={'task_metadata': _strip_task_metadata_for_list(t.task_metadata)})
        )
    return out


def _apply_task_type_filter(query, task_type: Optional[str]):
    if not task_type:
        return query
    if ',' in task_type:
        types = [x.strip() for x in task_type.split(',') if x.strip()]
        if types:
            return query.filter(models.Task.task_type.in_(types))
        return query
    return query.filter(models.Task.task_type == task_type)


class TaskUpdateRequest(BaseModel):
    name: Optional[str] = None


class EvalThresholdsRequest(BaseModel):
    conf_threshold: float
    iou_threshold: float
    per_class_conf: Optional[dict] = None  # {class_name: threshold}
    precision: Optional[float] = None
    recall: Optional[float] = None
    f1_score: Optional[float] = None


@router.get("/tasks/", response_model=List[schemas.Task])
async def get_tasks(
    project_id: Optional[int] = None,
    task_type: Optional[str] = None,
    status: Optional[str] = None,
    skip: int = 0,
    limit: int = 100,
    recent_hours: Optional[float] = None,
    metadata_mode: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Get tasks with optional filtering.
    When recent_hours is set (e.g. 1), returns tasks that are either active (pending/running)
    or completed within the last N hours, so long-running tasks (e.g. training) still appear
    after completion for the navbar 'last hour' view.
    metadata_mode=list (default) strips large evaluation payloads from task_metadata for faster list UIs.
    Use metadata_mode=full only when you need full inline results on a list response.
    task_type may be comma-separated (e.g. yolo_training,training)."""
    try:
        query = db.query(models.Task)

        if project_id:
            query = query.filter(models.Task.project_id == project_id)
        if status:
            query = query.filter(models.Task.status == status)
        query = _apply_task_type_filter(query, task_type)

        if recent_hours is not None and recent_hours > 0:
            cutoff = datetime.utcnow() - timedelta(hours=recent_hours)
            # Include: active tasks (any age) OR completed/failed/cancelled in last N hours
            # Also include tasks created in last N hours (fallback if completed_at not set)
            query_filtered = query.filter(
                or_(
                    models.Task.status.in_(['pending', 'running']),
                    and_(
                        models.Task.completed_at.isnot(None),
                        models.Task.completed_at >= cutoff
                    ),
                    models.Task.created_at >= cutoff
                )
            )
            result = query_filtered.order_by(models.Task.created_at.desc()).offset(skip).limit(limit).all()
            # If filter returned nothing, return most recent tasks so navbar always shows something
            if not result:
                query_fallback = db.query(models.Task)
                if project_id:
                    query_fallback = query_fallback.filter(models.Task.project_id == project_id)
                query_fallback = _apply_task_type_filter(query_fallback, task_type)
                if status:
                    query_fallback = query_fallback.filter(models.Task.status == status)
                result = query_fallback.order_by(models.Task.created_at.desc()).offset(skip).limit(min(limit, 50)).all()
            return _tasks_to_schema_list(result, metadata_mode or 'list')

        result = query.order_by(models.Task.created_at.desc()).offset(skip).limit(limit).all()
        return _tasks_to_schema_list(result, metadata_mode or 'list')
    except Exception as e:
        logger.error(f"Database error in get_tasks: {e}")
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")


@router.get("/tasks/active", response_model=List[schemas.Task])
async def get_active_tasks(
    project_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """Get currently active tasks (pending or running).

    Always returns metadata_mode=list-style payloads (heavy evaluation keys stripped)
    so the navbar can poll without downloading multi‑MB task_metadata blobs.
    """
    try:
        query = db.query(models.Task).filter(
            models.Task.status.in_(['pending', 'running'])
        )
        
        if project_id:
            query = query.filter(models.Task.project_id == project_id)
        
        # Use execution options for better connection management
        query = query.execution_options(autocommit=True)

        result = query.order_by(models.Task.created_at.desc()).all()
        return _tasks_to_schema_list(result, "list")
    except Exception as e:
        logger.error(f"Database error in get_active_tasks: {e}")
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")


@router.get("/tasks/count", response_model=dict)
async def get_task_counts(
    project_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """Get count of tasks by status"""
    query = db.query(models.Task)
    
    if project_id:
        query = query.filter(models.Task.project_id == project_id)
    
    # Count tasks by status
    pending_count = query.filter(models.Task.status == 'pending').count()
    running_count = query.filter(models.Task.status == 'running').count()
    completed_count = query.filter(models.Task.status == 'completed').count()
    failed_count = query.filter(models.Task.status == 'failed').count()
    cancelled_count = query.filter(models.Task.status == 'cancelled').count()
    
    active_count = pending_count + running_count
    
    return {
        "active": active_count,
        "pending": pending_count,
        "running": running_count,
        "completed": completed_count,
        "failed": failed_count,
        "cancelled": cancelled_count,
        "total": query.count()
    }


@router.get("/tasks/{task_id}", response_model=schemas.Task)
async def get_task(task_id: int, db: Session = Depends(get_db)):
    """Get task status and progress"""
    try:
        # Use first() with proper error handling instead of all()
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        
        # Explicitly commit the read to release connection quickly
        db.commit()
        return task
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Database error in get_task: {e}")
        db.rollback()
        raise HTTPException(status_code=500, detail="Database error")


@router.patch("/tasks/{task_id}/cancel")
async def cancel_task(task_id: int, db: Session = Depends(get_db)):
    """Cancel policy:
    - running: stop immediately (status=stopped) and revoke worker task
    - pending/paused: revoke and delete task
    """
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.status in ['completed', 'failed', 'cancelled', 'stopped']:
        raise HTTPException(status_code=400, detail=f"Cannot cancel task with status '{task.status}'")
    
    # Get the Celery task ID from metadata
    celery_task_id = None
    if task.task_metadata and isinstance(task.task_metadata, dict):
        celery_task_id = task.task_metadata.get('celery_task_id')

    # Pending/paused tasks should be deleted outright
    if task.status in ('pending', 'paused'):
        celery_task_revoked = False
        if celery_task_id:
            try:
                # Revoke queued/executing Celery work before deleting task row.
                celery_app.control.revoke(celery_task_id, terminate=True, signal='SIGKILL')
                logger.info(f"Revoked Celery task {celery_task_id} before deleting DB task {task_id}")
                
                # Also delete from result backend to prevent auto-requeue
                try:
                    celery_app.backend.delete(celery_task_id)
                    logger.info(f"Purged Celery result backend entry for task {celery_task_id}")
                except Exception as e:
                    logger.warning(f"Failed to purge result backend for {celery_task_id}: {e}")
                
                celery_task_revoked = True
            except Exception as e:
                logger.error(f"Failed to revoke Celery task {celery_task_id}: {e}")

        # Delete training model files if this is a training task
        if task.task_type in ['yolo_training', 'training']:
            try:
                task_metadata = task.task_metadata or {}
                results_dir = task_metadata.get('results_dir')

                if not results_dir and task.project_id:
                    training_dir = Path("projects") / str(task.project_id) / "training" / f"task_{task_id}"
                    if training_dir.exists():
                        results_dir = str(training_dir / "training")

                if results_dir:
                    results_path = Path(results_dir)
                    if results_path.exists():
                        task_dir = results_path.parent
                        if task_dir.exists() and task_dir.name.startswith('task_'):
                            shutil.rmtree(task_dir, ignore_errors=True)
                            logger.info(f"Deleted training files for task {task_id} from {task_dir}")
            except Exception as e:
                logger.warning(f"Failed to delete training files for task {task_id}: {e}")

        # Delete associated augmentation if exists
        augmentation = db.query(models.Augmentation).filter(models.Augmentation.task_id == task_id).first()
        if augmentation:
            db.delete(augmentation)

        db.delete(task)
        db.commit()

        return {
            "success": True,
            "message": "Task deleted successfully",
            "task_id": task_id,
            "status": "deleted",
            "celery_task_revoked": celery_task_revoked,
        }

    # Running task: mark as stopped immediately and revoke worker process.
    if task.task_metadata is None:
        task.task_metadata = {}
    if isinstance(task.task_metadata, dict):
        task.task_metadata["stop_requested_at"] = datetime.utcnow().isoformat()
        task.task_metadata["stop_mode"] = "force"
        task.task_metadata["stage"] = "stop_requested"
        flag_modified(task, "task_metadata")

    task.status = 'stopped'
    task.completed_at = datetime.utcnow()
    task.error_message = 'Task stopped by user'

    db.commit()

    # Send SIGTERM/SIGKILL to interrupt active worker execution and clean up Celery result backend.
    celery_task_revoked = False
    if celery_task_id:
        try:
            # CPU-bound annotation work may not yield quickly; SIGKILL stops the worker process.
            stop_signal = (
                "SIGKILL"
                if task.task_type in ("annotation_processing", "annotation_merge")
                else "SIGTERM"
            )
            celery_app.control.revoke(celery_task_id, terminate=True, signal=stop_signal)
            logger.info(f"Sent {stop_signal} to Celery task {celery_task_id} for task {task_id}")
            celery_task_revoked = True
            
            # Also delete from result backend to prevent auto-requeue on container restart
            try:
                celery_app.backend.delete(celery_task_id)
                logger.info(f"Purged Celery result backend entry for task {celery_task_id}")
            except Exception as e:
                logger.warning(f"Failed to purge result backend for {celery_task_id}: {e}")
        except Exception as e:
            logger.error(f"Failed to revoke Celery task {celery_task_id}: {e}")

    return {
        "success": True,
        "message": "Task stopped successfully",
        "task_id": task_id,
        "status": task.status,
        "celery_task_revoked": celery_task_revoked,
    }


@router.patch("/tasks/{task_id}/pause")
async def pause_task(task_id: int, db: Session = Depends(get_db)):
    """Pause a running training task. The training loop will detect this at the next epoch boundary,
    save last.pt, store resume_from in metadata, and stop cleanly."""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status != 'running':
        raise HTTPException(status_code=400, detail=f"Cannot pause task with status '{task.status}' (must be 'running')")

    if task.task_metadata is None:
        task.task_metadata = {}
    if isinstance(task.task_metadata, dict):
        task.task_metadata["pause_requested_at"] = datetime.utcnow().isoformat()
        task.task_metadata["stage"] = "pause_requested"
        flag_modified(task, "task_metadata")
    db.commit()

    return {
        "success": True,
        "message": "Pause requested — training will stop at next epoch boundary",
        "task_id": task_id,
        "status": task.status,
    }


@router.patch("/tasks/{task_id}/resume")
async def resume_task(task_id: int, db: Session = Depends(get_db)):
    """Resume a paused training task by dispatching a new Celery task continuing from last.pt."""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    metadata = task.task_metadata or {}

    # Recovery path: if backend restarted after pause was requested, task can remain
    # stuck in 'running' with pause_requested_at set even though no worker is active.
    pause_requested = isinstance(metadata, dict) and bool(metadata.get("pause_requested_at"))
    if task.status == 'running' and pause_requested:
        task.status = 'paused'
        task.task_metadata = {
            **metadata,
            "stage": "paused",
            "pause_requested_at": None,
            "paused_recovered_at": datetime.utcnow().isoformat(),
        }
        flag_modified(task, "task_metadata")
        db.commit()
        db.refresh(task)
        metadata = task.task_metadata or {}

    if task.status != 'paused':
        raise HTTPException(status_code=400, detail=f"Cannot resume task with status '{task.status}' (must be 'paused')")

    if task.task_type == 'mmyolo_training':
        raise HTTPException(
            status_code=400,
            detail="MMYOLO pause/resume is not supported yet. Use rerun for MMYOLO tasks."
        )

    resume_from = metadata.get("resume_from")
    if not resume_from:
        # Best-effort fallback for older tasks where resume_from was not persisted.
        candidates = [
            metadata.get("last_model"),
            metadata.get("yolo_last_model"),
            metadata.get("best_model"),
            metadata.get("yolo_best_model"),
        ]
        if task.project_id:
            task_root = Path("projects") / str(task.project_id) / "training" / f"task_{task_id}"
            candidates.extend([
                str(task_root / "training" / "weights" / "last.pt"),
                str(task_root / "training" / "last.pt"),
                str(task_root / "training" / "weights" / "best.pt"),
                str(task_root / "training" / "best.pt"),
            ])

        for candidate in candidates:
            if candidate and Path(candidate).exists():
                resume_from = str(candidate)
                break

    if not resume_from:
        raise HTTPException(status_code=400, detail="No resume checkpoint found. The training may not have saved a checkpoint yet.")

    # Build the original training config from metadata
    training_config = metadata.get("training_config") or {}
    # Inject resume path into config
    training_config = {**training_config, "resume_from": resume_from}

    task_type = task.task_type
    model_variant = str(metadata.get("model_variant") or "").lower()
    model_type_hint = str(
        metadata.get("model_type")
        or training_config.get("model_type")
        or ""
    ).lower()
    is_rtdetr = task_type == 'training' and (model_variant.startswith('rtdetr') or model_type_hint.startswith('rtdetr'))

    # Create a new task record for the resumed run
    from app.models import Task as TaskModel
    new_task = TaskModel(
        name=f"{task.name} (resumed)",
        task_type=task_type,
        status="pending",
        progress=0,
        project_id=task.project_id,
        task_metadata={
            "training_config": training_config,
            "stage": "pending",
            "resumed_from_task_id": task_id,
            "resume_from": resume_from,
            "paused_epoch": metadata.get("paused_epoch"),
        },
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)

    # Dispatch to worker-gpu (gpu queue), not worker-general
    from app.ml.celery_dispatch import enqueue_training_task

    if is_rtdetr:
        from app.tasks.rtdetr_training import train_rtdetr_model as train_task

        framework_id = "ultralytics.rtdetr"
    else:
        from app.tasks.yolo_training import train_yolo_model as train_task

        framework_id = "ultralytics.yolo"

    celery_result = enqueue_training_task(
        train_task, new_task.id, training_config, framework_id
    )

    new_task.task_metadata = {
        **(new_task.task_metadata or {}),
        "celery_task_id": celery_result.id,
    }
    flag_modified(new_task, "task_metadata")
    db.commit()

    return {
        "success": True,
        "message": "Training resumed as a new task",
        "original_task_id": task_id,
        "new_task_id": new_task.id,
        "celery_task_id": celery_result.id,
    }



@router.patch("/tasks/{task_id}")
async def update_task(task_id: int, update: TaskUpdateRequest, db: Session = Depends(get_db)):
    """Update task properties like name"""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    # Update name if provided
    if update.name is not None:
        task.name = update.name
    
    db.commit()
    db.refresh(task)
    
    return {
        "success": True,
        "message": "Task updated successfully",
        "task": {
            "id": task.id,
            "name": task.name,
            "status": task.status
        }
    }


@router.patch("/tasks/{task_id}/eval-thresholds")
async def save_eval_thresholds(task_id: int, request: EvalThresholdsRequest, db: Session = Depends(get_db)):
    """Save evaluation threshold parameters back to task metadata"""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    metadata = task.task_metadata or {}
    results = metadata.get('results', {})
    results['conf_threshold'] = request.conf_threshold
    results['iou_threshold'] = request.iou_threshold
    if request.per_class_conf is not None:
        results['per_class_conf'] = request.per_class_conf
    if request.precision is not None:
        results['precision'] = request.precision
    if request.recall is not None:
        results['recall'] = request.recall
    if request.f1_score is not None:
        results['f1_score'] = request.f1_score
    task.task_metadata = {
        **metadata,
        'results': results,
        'conf_threshold': request.conf_threshold,
        'iou_threshold': request.iou_threshold,
    }
    flag_modified(task, "task_metadata")
    db.commit()
    return {"success": True, "conf_threshold": request.conf_threshold, "iou_threshold": request.iou_threshold}


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: int, db: Session = Depends(get_db)):
    """Delete a task and its associated data, including model files"""
    try:
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        
        # Check if task is still running - only warn for active tasks
        if task.status in ['pending', 'running']:
            # Try to cancel it first
            if task.task_metadata and isinstance(task.task_metadata, dict):
                celery_task_id = task.task_metadata.get('celery_task_id')
                if celery_task_id:
                    try:
                        celery_app.control.revoke(celery_task_id, terminate=True, signal='SIGKILL')
                        logger.info(f"Terminated Celery task {celery_task_id} before deletion")
                    except Exception as e:
                        logger.error(f"Failed to terminate Celery task {celery_task_id}: {e}")
        
        # Delete training model files if this is a training task
        if task.task_type in ['yolo_training', 'training']:
            try:
                task_metadata = task.task_metadata or {}
                results_dir = task_metadata.get('results_dir')
                
                # Also try to construct the path from project_id and task_id
                if not results_dir and task.project_id:
                    training_dir = Path("projects") / str(task.project_id) / "training" / f"task_{task_id}"
                    if training_dir.exists():
                        results_dir = str(training_dir / "training")
                
                if results_dir:
                    results_path = Path(results_dir)
                    if results_path.exists():
                        # Delete the entire training directory for this task
                        task_dir = results_path.parent  # Go up to task_{task_id} directory
                        if task_dir.exists() and task_dir.name.startswith('task_'):
                            shutil.rmtree(task_dir, ignore_errors=True)
                            logger.info(f"Deleted training files for task {task_id} from {task_dir}")
            except Exception as e:
                logger.warning(f"Failed to delete training files for task {task_id}: {e}")
                # Continue with database deletion even if file deletion fails
        
        # Delete associated augmentation if exists
        augmentation = db.query(models.Augmentation).filter(models.Augmentation.task_id == task_id).first()
        if augmentation:
            db.delete(augmentation)
        
        # Delete the task
        db.delete(task)
        db.commit()
        
        return {
            "success": True,
            "message": "Task deleted successfully"
        }
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete task: {str(e)}")


@router.delete("/projects/{project_id}/tasks/failed")
async def delete_failed_tasks(project_id: int, db: Session = Depends(get_db)):
    """Delete all failed tasks for a project"""
    try:
        # Get all failed tasks for this project
        failed_tasks = db.query(models.Task).filter(
            models.Task.project_id == project_id,
            models.Task.status == 'failed'
        ).all()
        
        if not failed_tasks:
            return {
                "success": True,
                "message": "No failed tasks to delete",
                "deleted_count": 0
            }
        
        deleted_count = len(failed_tasks)
        
        # Delete associated augmentations if they exist
        for task in failed_tasks:
            augmentation = db.query(models.Augmentation).filter(
                models.Augmentation.task_id == task.id
            ).first()
            if augmentation:
                db.delete(augmentation)
            db.delete(task)
        
        db.commit()
        
        return {
            "success": True,
            "message": f"Deleted {deleted_count} failed task(s)",
            "deleted_count": deleted_count
        }
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete tasks: {str(e)}")


@router.patch("/tasks/{task_id}/retry")
async def retry_task(task_id: int, db: Session = Depends(get_db)):
    """Retry a failed task"""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.status not in ['failed', 'cancelled']:
        raise HTTPException(status_code=400, detail=f"Cannot retry task with status '{task.status}'")
    
    # Reset task status
    task.status = 'pending'
    task.progress = 0.0
    task.started_at = None
    task.completed_at = None
    task.error_message = None
    db.commit()
    
    # Note: In a real implementation, you would need to restart the background task here
    # For now, we just reset the status
    
    return {
        "success": True,
        "message": "Task reset to pending status",
        "task_id": task_id
    }


@router.post("/tasks/{task_id}/rerun")
async def rerun_task(task_id: int, db: Session = Depends(get_db)):
    """Rerun a model evaluation task with the same parameters"""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.task_type != 'model_evaluation':
        raise HTTPException(status_code=400, detail="Only model evaluation tasks can be rerun")
    
    # Allow rerunning completed, failed, cancelled, or stopped tasks
    if task.status not in ['completed', 'failed', 'cancelled', 'stopped']:
        raise HTTPException(status_code=400, detail=f"Cannot rerun task with status '{task.status}'")
    
    # Get parameters from task metadata
    metadata = task.task_metadata or {}
    training_task_id = metadata.get('training_task_id')
    dataset_id = metadata.get('dataset_id')
    annotation_file_id = metadata.get('annotation_file_id')
    checkpoint = metadata.get('checkpoint', 'best')
    conf_threshold = metadata.get('conf_threshold', 0.25)
    iou_threshold = metadata.get('iou_threshold', 0.45)
    use_grid = metadata.get('use_grid', False)
    grid_size = metadata.get('grid_size', 640)
    grid_overlap = metadata.get('grid_overlap', 0.2)
    
    if not training_task_id or not dataset_id:
        raise HTTPException(status_code=400, detail="Task metadata is missing required parameters")
    
    # Validate training task exists
    training_task = db.query(models.Task).filter(models.Task.id == training_task_id).first()
    if not training_task or training_task.status != 'completed':
        raise HTTPException(status_code=404, detail="Training task not found or not completed")
    
    # Validate dataset exists
    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    # Get annotation file name if provided
    annotation_file_name = None
    if annotation_file_id:
        from ..models import AnnotationFile
        annotation_file = db.query(AnnotationFile).filter(AnnotationFile.id == annotation_file_id).first()
        if annotation_file:
            annotation_file_name = annotation_file.name
    
    # Generate new task name, removing existing (Rerun) suffix if present
    base_name = task.name
    if base_name.endswith(" (Rerun)"):
        base_name = base_name[:-8]  # Remove " (Rerun)"
    new_task_name = f"{base_name} (Rerun)"
    
    # Create new evaluation task with same parameters
    new_task = models.Task(
        name=new_task_name,
        task_type="model_evaluation",
        status="pending",
        project_id=task.project_id,
        progress=0,
        task_metadata={
            "training_task_id": training_task_id,
            "training_task_name": metadata.get('training_task_name'),
            "dataset_id": dataset_id,
            "dataset_name": metadata.get('dataset_name'),
            "annotation_file_id": annotation_file_id,
            "annotation_file_name": annotation_file_name,
            "checkpoint": checkpoint,
            "conf_threshold": conf_threshold,
            "iou_threshold": iou_threshold,
            "model_type": metadata.get('model_type', 'Unknown'),
            "has_ground_truth": annotation_file_id is not None,
            "use_grid": use_grid,
            "grid_size": grid_size,
            "grid_overlap": grid_overlap
        }
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    
    # Start Celery task
    try:
        from app.tasks.evaluation_tasks import evaluate_model as evaluate_model_task
        
        celery_task = evaluate_model_task.delay(
            new_task.id,
            training_task_id,
            dataset_id,
            annotation_file_id,
            checkpoint,
            conf_threshold,
            iou_threshold,
            use_grid,
            grid_size,
            grid_overlap
        )
        
        # Update task with Celery ID
        new_task.task_metadata = {
            **new_task.task_metadata,
            'celery_task_id': celery_task.id
        }
        db.commit()
        
        logger.info(f"Started rerun evaluation task {new_task.id} with Celery task {celery_task.id}")
        
    except Exception as e:
        logger.error(f"Error starting rerun evaluation: {str(e)}", exc_info=True)
        # Update task status to failed
        new_task.status = 'failed'
        new_task.error_message = f"Failed to start evaluation: {str(e)}"
        db.commit()
        raise HTTPException(status_code=500, detail=f"Failed to start evaluation: {str(e)}")
    
    return {
        "success": True,
        "message": "Evaluation task rerun started",
        "task_id": new_task.id,
        "task_name": new_task.name
    }


@router.get("/tasks/{task_id}/logs")
async def get_task_logs(task_id: int, db: Session = Depends(get_db)):
    """Get logs for a specific task"""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    # In a real implementation, you would store and retrieve actual log files
    # For now, we'll return basic task information as "logs"
    logs = []
    
    logs.append(f"[{task.created_at}] Task created: {task.name}")
    
    if task.started_at:
        logs.append(f"[{task.started_at}] Task started")
    
    if task.status == 'running':
        logs.append(f"[{datetime.utcnow()}] Task in progress: {task.progress:.1f}% complete")
    elif task.status == 'completed':
        logs.append(f"[{task.completed_at}] Task completed successfully")
    elif task.status == 'failed':
        logs.append(f"[{task.completed_at}] Task failed: {task.error_message}")
    elif task.status == 'cancelled':
        logs.append(f"[{task.completed_at}] Task cancelled: {task.error_message}")
    
    return {
        "success": True,
        "task_id": task_id,
        "logs": logs
    }


_EXAMPLE_SPLITS = frozenset({"train", "val", "test", "val_predictions"})


def _task_examples_dir(task) -> Path:
    metadata = task.task_metadata or {}
    examples_path = metadata.get("examples_path")
    if not examples_path:
        raise HTTPException(status_code=404, detail="No training examples found for this task")
    return Path(examples_path)


@router.get("/tasks/{task_id}/examples/{split}")
async def get_task_example_image(task_id: int, split: str, db: Session = Depends(get_db)):
    """Legacy batch mosaic image (train_batch.jpg, etc.)."""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if split not in _EXAMPLE_SPLITS:
        raise HTTPException(
            status_code=400,
            detail="Invalid split. Must be 'train', 'val', 'test', or 'val_predictions'",
        )

    examples_path = _task_examples_dir(task)
    filename = (
        "val_predictions_batch.jpg" if split == "val_predictions" else f"{split}_batch.jpg"
    )
    file_path = examples_path / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Example image for {split} split not found")

    return FileResponse(path=file_path, media_type="image/jpeg", filename=filename)


@router.get("/tasks/{task_id}/examples/{split}/sample/{index}")
async def get_task_example_sample(
    task_id: int, split: str, index: int, db: Session = Depends(get_db)
):
    """Single annotated training sample (example_1.jpg … example_3.jpg) for GUI inspection."""
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if split not in {"train", "val", "test"}:
        raise HTTPException(
            status_code=400,
            detail="Sample index only applies to train, val, or test splits",
        )
    if index < 1 or index > 3:
        raise HTTPException(status_code=400, detail="Sample index must be 1, 2, or 3")

    examples_path = _task_examples_dir(task)
    file_path = examples_path / split / f"example_{index}.jpg"
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Example sample {index} for {split} not found",
        )

    return FileResponse(
        path=file_path,
        media_type="image/jpeg",
        filename=f"{split}_example_{index}.jpg",
    )
