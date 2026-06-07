"""Celery queue helpers for model backends and GPU worker dispatch."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.ml.registry import celery_queue_for_backend, get_backend

GPU_QUEUE = "gpu"
MMYOLO_QUEUE = "mmyolo"
GENERAL_QUEUE = "general"


def enqueue_training_task(celery_task: Any, task_id: int, training_config: Dict[str, Any], framework_id: str):
    """Dispatch training to the runtime-profile Celery queue (gpu or mmyolo)."""
    backend = get_backend(framework_id)
    queue = celery_queue_for_backend(backend)
    return celery_task.apply_async(args=[task_id, training_config], queue=queue)


def send_gpu_task(
    task_name: str,
    *,
    args: Optional[List[Any]] = None,
    kwargs: Optional[Dict[str, Any]] = None,
    queue: str = GPU_QUEUE,
):
    """
    Publish a task to worker-gpu via the GPU Celery app.

    Use this from the API instead of ``celery_app`` (general) so routing stays
    on worker-gpu queues.
    """
    from app.celery.gpu_app import celery_app as gpu_app

    return gpu_app.send_task(
        task_name,
        args=args or [],
        kwargs=kwargs or {},
        queue=queue,
    )
