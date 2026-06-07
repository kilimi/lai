"""Centralized model backend resolution."""
from __future__ import annotations

from typing import Any

from app.ml.protocols import ModelBackend
from app.ml.registry import get_backend, get_backend_for_task


def get_model_backend(task_or_framework_id: Any) -> ModelBackend:
    """
    Resolve a model backend from a Task ORM object, task dict, or framework_id string.
    """
    if isinstance(task_or_framework_id, str):
        return get_backend(task_or_framework_id)
    return get_backend_for_task(task_or_framework_id)


def is_mmyolo_task(task: Any) -> bool:
    """True when task uses the MMYOLO backend."""
    try:
        return get_model_backend(task).runtime_profile == "mmyolo"
    except KeyError:
        return False


def framework_label_for_task(task: Any) -> str:
    """Return 'mmyolo' or 'ultralytics' for evaluation metadata."""
    try:
        backend = get_model_backend(task)
        if backend.runtime_profile == "mmyolo":
            return "mmyolo"
        return "ultralytics"
    except KeyError:
        return "ultralytics"
