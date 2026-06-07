"""
Backward-compatible Celery entry point.

Workers should start with:
  celery -A app.celery.general_app worker -Q general ...
  celery -A app.celery.gpu_app worker -Q gpu,mmyolo ...

`celery_app` aliases the general app (shared broker; revoke works across apps).
"""
from app.celery.general_app import celery_app
from app.celery.gpu_app import celery_app as gpu_app
from app.celery.worker_hooks import (
    collect_worker_gpu_status,
    publish_worker_gpu_status,
    sync_tasks_with_database as _sync_tasks_with_database,
    upsert_worker_gpu_status_db,
)

def sync_tasks_with_database():
    """Backward-compatible worker startup sync (uses general app broker)."""
    _sync_tasks_with_database(celery_app)

# Legacy names used by tests and task_monitoring
_collect_worker_gpu_status = collect_worker_gpu_status
_publish_worker_gpu_status = publish_worker_gpu_status
_upsert_worker_gpu_status_db = upsert_worker_gpu_status_db

__all__ = [
    "celery_app",
    "gpu_app",
    "sync_tasks_with_database",
    "collect_worker_gpu_status",
    "publish_worker_gpu_status",
    "upsert_worker_gpu_status_db",
    "_collect_worker_gpu_status",
    "_publish_worker_gpu_status",
    "_upsert_worker_gpu_status_db",
]
