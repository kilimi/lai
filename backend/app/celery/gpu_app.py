"""
GPU Celery worker application (YOLO, eval, export, auto-annotate, MMYOLO orchestration).
"""
from app.celery.worker_site import prefer_lai_site_packages

prefer_lai_site_packages()

from celery import Celery

from app.celery._config import GPU_INCLUDE, REDIS_URL, apply_common_config
from app.celery.worker_hooks import register_gpu_worker_hooks

celery_app = Celery(
    "lai-gpu",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=GPU_INCLUDE,
)

apply_common_config(celery_app, enable_beat=False)
register_gpu_worker_hooks(celery_app)
