"""GPU-worker-only monitoring tasks (registered on gpu_app)."""
from __future__ import annotations

from typing import Any, Dict

from app.celery.gpu_app import celery_app


@celery_app.task(name="app.tasks.task_monitoring.refresh_worker_gpu_status")
def refresh_worker_gpu_status() -> Dict[str, Any]:
    """On-demand worker GPU sample for UI/API requests."""
    from app.celery.worker_hooks import (
        collect_worker_gpu_status,
        publish_worker_gpu_status,
        upsert_worker_gpu_status_db,
    )

    status = collect_worker_gpu_status()
    publish_worker_gpu_status()
    upsert_worker_gpu_status_db()
    return status
