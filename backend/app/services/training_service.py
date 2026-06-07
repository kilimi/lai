"""Training task orchestration shared by API routers and Celery workers."""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

from sqlalchemy.orm import Session

from app.ml.celery_dispatch import enqueue_training_task
from app.models import Task
from app.task_dispatch import ensure_inline_dispatch_allowed, use_celery_enabled

logger = logging.getLogger(__name__)


def attach_celery_task_id(db: Session, task: Task, celery_async_result: Any) -> None:
    """Persist Celery async result id on the ORM task row."""
    task.task_metadata = {
        **(task.task_metadata or {}),
        "celery_task_id": celery_async_result.id,
    }
    db.commit()


def dispatch_training(
    db: Session,
    task: Task,
    training_config: Dict[str, Any],
    *,
    framework_id: str,
    celery_task: Callable,
    use_celery: Optional[bool] = None,
    feature_name: str = "Training",
) -> Any:
    """
    Queue training on Celery (production path).

    Returns the Celery ``AsyncResult``. Raises HTTP 503 if Celery is disabled.
    """
    if use_celery is None:
        use_celery = use_celery_enabled()
    if not use_celery or celery_task is None:
        ensure_inline_dispatch_allowed(feature_name)
        from fastapi import HTTPException

        raise HTTPException(
            status_code=503,
            detail=f"{feature_name} requires Celery workers (worker-gpu). See docs/BACKGROUND_TASKS.md.",
        )

    logger.info("Queuing Celery training for task %s (framework=%s)", task.id, framework_id)
    async_result = enqueue_training_task(
        celery_task, task.id, training_config, framework_id
    )
    attach_celery_task_id(db, task, async_result)
    logger.info("Queued training task %s (celery_id=%s)", task.id, async_result.id)
    return async_result
