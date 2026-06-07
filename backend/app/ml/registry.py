"""Model backend registry with legacy task_type resolution."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.ml.protocols import ModelBackend
from app.ml.schemas import BackendInfo

logger = logging.getLogger(__name__)

_BACKENDS: Dict[str, ModelBackend] = {}
_LEGACY_TASK_TYPE_MAP: Dict[str, str] = {}


def _ensure_backends_registered() -> None:
    """Load built-in backends (idempotent). Required in Celery workers that skip main.py."""
    if _BACKENDS:
        return
    from app.ml.backends import register_all_backends

    register_all_backends()


def register_backend(backend: ModelBackend) -> None:
    """Register a model backend plugin."""
    if backend.id in _BACKENDS:
        logger.warning("Overwriting model backend registration for %s", backend.id)
    _BACKENDS[backend.id] = backend
    for legacy in backend.legacy_task_types():
        _LEGACY_TASK_TYPE_MAP[legacy] = backend.id


def get_backend(framework_id: str) -> ModelBackend:
    """Resolve backend by framework id."""
    _ensure_backends_registered()
    backend = _BACKENDS.get(framework_id)
    if backend is None:
        known = ", ".join(sorted(_BACKENDS)) or "(none)"
        raise KeyError(f"Unknown model backend '{framework_id}'. Known: {known}")
    return backend


def get_backend_for_task(task: Any) -> ModelBackend:
    """
    Resolve backend from a Task ORM object or dict-like task.

    Checks metadata.framework_id first, then legacy task_type.
    """
    meta: Dict[str, Any] = {}
    task_type: Optional[str] = None

    if isinstance(task, dict):
        meta = task.get("task_metadata") or {}
        task_type = task.get("task_type")
    else:
        meta = getattr(task, "task_metadata", None) or {}
        task_type = getattr(task, "task_type", None)

    framework_id = meta.get("framework_id")
    if framework_id:
        return get_backend(str(framework_id))

    if task_type:
        mapped = _LEGACY_TASK_TYPE_MAP.get(str(task_type))
        if mapped:
            logger.warning(
                "Resolving backend via legacy task_type=%r -> %s; set task_metadata.framework_id",
                task_type,
                mapped,
            )
            return get_backend(mapped)

        # Heuristic fallbacks for partially migrated metadata (deprecated)
        if meta.get("config_id") or meta.get("arch"):
            logger.warning(
                "Resolving MMYOLO via metadata heuristics (task_type=%r); set framework_id=mmyolo",
                task_type,
            )
            return get_backend("mmyolo")
        if meta.get("model_type", "").startswith("rtdetr") or meta.get("model_variant"):
            logger.warning(
                "Resolving RT-DETR via metadata heuristics; set framework_id=ultralytics.rtdetr"
            )
            return get_backend("ultralytics.rtdetr")
        if meta.get("model_type") or task_type in ("yolo_training", "training"):
            if "rtdetr" in str(meta.get("model_type", "")).lower() or meta.get("model_type") == "rtdetr":
                logger.warning(
                    "Resolving RT-DETR via model_type heuristic; set framework_id=ultralytics.rtdetr"
                )
                return get_backend("ultralytics.rtdetr")
            logger.warning(
                "Resolving YOLO via metadata heuristics (task_type=%r); set framework_id=ultralytics.yolo",
                task_type,
            )
            return get_backend("ultralytics.yolo")

    raise KeyError(
        f"Cannot resolve model backend for task_type={task_type!r}, "
        f"metadata keys={list(meta.keys())}"
    )


def list_backends() -> List[BackendInfo]:
    """List registered backends."""
    _ensure_backends_registered()
    return [b.to_backend_info() for b in _BACKENDS.values()]


def clear_registry() -> None:
    """Clear all registrations (for tests)."""
    _BACKENDS.clear()
    _LEGACY_TASK_TYPE_MAP.clear()


# runtime_profile (catalog / dispatch) vs Celery queue names (worker subscriptions)
_RUNTIME_PROFILE_CELERY_QUEUE: Dict[str, str] = {
    "ultralytics": "gpu",
    "mmyolo": "mmyolo",
    "general": "general",
    "gpu": "gpu",
}


def celery_queue_for_backend(backend: ModelBackend) -> str:
    """Map backend runtime profile to the Celery queue a worker consumes."""
    profile = backend.runtime_profile
    queue = _RUNTIME_PROFILE_CELERY_QUEUE.get(profile, profile)
    if queue != profile:
        logger.debug(
            "Celery queue for backend %s: runtime_profile=%r -> queue=%r",
            getattr(backend, "id", "?"),
            profile,
            queue,
        )
    return queue
