"""Model backend plugin system for training, evaluation, and inference."""

from app.ml.dispatch import get_model_backend, framework_label_for_task, is_mmyolo_task
from app.ml.registry import (
    get_backend,
    get_backend_for_task,
    list_backends,
    register_backend,
)

__all__ = [
    "get_backend",
    "get_backend_for_task",
    "get_model_backend",
    "framework_label_for_task",
    "is_mmyolo_task",
    "list_backends",
    "register_backend",
]
