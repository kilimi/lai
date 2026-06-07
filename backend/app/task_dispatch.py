"""
Background work dispatch policy (P0 guardrails).

Production: Celery workers (`worker-general`, `worker-gpu`).

Inline execution in the API process (FastAPI ``BackgroundTasks`` or synchronous task
calls) is disabled unless ``LAI_ALLOW_INLINE_TASKS=true`` (local dev only).
"""
from __future__ import annotations

import logging
import os

from fastapi import HTTPException

logger = logging.getLogger(__name__)

ALLOW_INLINE_TASKS = os.environ.get("LAI_ALLOW_INLINE_TASKS", "false").lower() == "true"


def use_celery_enabled() -> bool:
    return os.environ.get("USE_CELERY", "true").lower() == "true"


def ensure_inline_dispatch_allowed(feature: str) -> None:
    """
    Call before running work in the API process instead of Celery.

    Raises HTTP 503 unless ``LAI_ALLOW_INLINE_TASKS=true`` (dev escape hatch).
    """
    if ALLOW_INLINE_TASKS:
        logger.warning(
            "LAI_ALLOW_INLINE_TASKS=true: running %s in API process (dev only — not for production)",
            feature,
        )
        return

    raise HTTPException(
        status_code=503,
        detail=(
            f"{feature} requires Celery workers. "
            "Run the stack with `lai up` (includes worker-general and worker-gpu). "
            "For single-process local experiments only, set LAI_ALLOW_INLINE_TASKS=true."
        ),
    )
