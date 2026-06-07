"""
Ultralytics YOLO / RT-DETR loaders with 8.3 and 8.4+ compatibility.

Import from here instead of `from ultralytics import YOLO` in tasks and routers
so CPU workers never load ML stacks at module import time.
"""
from __future__ import annotations

from typing import Any, Type


def load_yolo_class() -> Type[Any]:
    """Return the Ultralytics YOLO class (lazy import)."""
    try:
        from ultralytics import YOLO
    except ImportError:
        from ultralytics.models import YOLO
    return YOLO


def load_rtdetr_class() -> Type[Any]:
    """Return the Ultralytics RTDETR class (lazy import)."""
    try:
        from ultralytics import RTDETR
    except ImportError:
        from ultralytics.models import RTDETR
    return RTDETR
