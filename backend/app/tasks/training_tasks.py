"""
Backward-compatible re-exports for training Celery tasks.

Prefer direct imports, e.g. `from app.tasks.yolo_training import train_yolo_model`.
"""
from app.tasks.mmyolo_config import resolve_mmyolo_base_config
from app.tasks.mmyolo_dji import prepare_dji_mmyolo_repo
from app.tasks.mmyolo_training import train_mmyolo_model
from app.tasks.rtdetr_training import train_rtdetr_model
from app.tasks.training_common import MMYOLO_PYTHON, TrainingTask
from app.tasks.yolo_training import train_yolo_model

_resolve_mmyolo_base_config = resolve_mmyolo_base_config
_prepare_dji_mmyolo_repo = prepare_dji_mmyolo_repo

__all__ = [
    "TrainingTask",
    "MMYOLO_PYTHON",
    "train_yolo_model",
    "train_rtdetr_model",
    "train_mmyolo_model",
    "resolve_mmyolo_base_config",
    "prepare_dji_mmyolo_repo",
    "_resolve_mmyolo_base_config",
    "_prepare_dji_mmyolo_repo",
]
