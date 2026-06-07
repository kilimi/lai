"""Task metadata conventions (framework_id migration)."""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

KNOWN_FRAMEWORK_IDS = frozenset(
    {
        "ultralytics.yolo",
        "ultralytics.rtdetr",
        "mmyolo",
    }
)


def merge_task_metadata(
    metadata: Optional[Dict[str, Any]],
    *,
    framework_id: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build task_metadata with required ``framework_id``."""
    out: Dict[str, Any] = dict(metadata or {})
    if framework_id:
        out["framework_id"] = framework_id
    if extra:
        out.update(extra)
    return out


def ensure_framework_id(metadata: Optional[Dict[str, Any]]) -> str:
    """Return framework_id or raise ValueError."""
    fid = (metadata or {}).get("framework_id")
    if not fid:
        raise ValueError("task_metadata.framework_id is required for ML tasks")
    return str(fid)
