"""
CPU / I/O Celery worker application (no ultralytics import at startup).
"""
from celery import Celery

from app.celery._config import GENERAL_INCLUDE, REDIS_URL, apply_common_config
from app.celery.worker_hooks import register_general_worker_hooks

celery_app = Celery(
    "lai-general",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=GENERAL_INCLUDE,
)

apply_common_config(celery_app, enable_beat=True)
register_general_worker_hooks(celery_app)
