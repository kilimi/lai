"""Split Celery applications: general (CPU) and gpu (YOLO / MMYOLO orchestration)."""

from app.celery.general_app import celery_app as general_app
from app.celery.gpu_app import celery_app as gpu_app

__all__ = ["general_app", "gpu_app"]
