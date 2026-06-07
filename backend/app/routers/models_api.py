"""Unified model catalog and training start API."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.foundation_models import pretrained_yolo_catalog
from app.ml.dispatch import get_model_backend
from app.ml.registry import get_backend, list_backends
from app.models import Task

logger = logging.getLogger(__name__)
router = APIRouter()

USE_CELERY = os.environ.get("USE_CELERY", "true").lower() == "true"


class UnifiedTrainingStartRequest(BaseModel):
    framework_id: str
    project_id: int
    dataset_configs: List[Dict[str, Any]]
    task_name: Optional[str] = None
    params: Dict[str, Any] = Field(default_factory=dict)


@router.get("/models/catalog")
async def get_models_catalog():
    """Aggregate training catalog from all registered model backends."""
    from app.ml.backends import register_all_backends

    register_all_backends()
    backends = []
    for info in list_backends():
        backend = get_backend(info.id)
        cat = backend.catalog()
        backends.append(
            {
                "id": cat.backend_id,
                "display_name": cat.display_name,
                "runtime_profile": cat.runtime_profile,
                "supports_export": cat.supports_export,
                "supports_pause_resume": cat.supports_pause_resume,
                "variants": [
                    {
                        "id": v.id,
                        "display_name": v.display_name,
                        "task": v.task.value,
                        "pretrained_filename": v.pretrained_filename,
                        "metadata": v.metadata,
                    }
                    for v in cat.variants
                ],
                "request_schema": cat.request_schema,
            }
        )
    return {
        "backends": backends,
        "pretrained_ultralytics": pretrained_yolo_catalog(),
    }


@router.post("/training/start")
async def start_unified_training(
    request: UnifiedTrainingStartRequest,
    db: Session = Depends(get_db),
):
    """
    Start training for any registered framework.

    Body: { framework_id, project_id, dataset_configs, task_name?, params: { ... } }
    """
    from app.ml.backends import register_all_backends

    register_all_backends()
    try:
        backend = get_backend(request.framework_id)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    body = {
        "project_id": request.project_id,
        "dataset_configs": request.dataset_configs,
        "task_name": request.task_name,
        **request.params,
    }
    try:
        spec = backend.validate_start_request(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from app.services import training_operations_service as training_ops
    from app.services.training_schemas import (
        MMYOLOTrainingRequest,
        RTDETRTrainingRequest,
        YoloTrainingRequest,
    )

    if request.framework_id == "ultralytics.yolo":
        yolo_req = YoloTrainingRequest(**body)
        return await training_ops.start_yolo_training(yolo_req, db)
    if request.framework_id == "ultralytics.rtdetr":
        rtdetr_req = RTDETRTrainingRequest(**body)
        return await training_ops.start_rtdetr_training(rtdetr_req, db)
    if request.framework_id == "mmyolo":
        mmyolo_req = MMYOLOTrainingRequest(**body)
        return await training_ops.start_mmyolo_training(mmyolo_req, db)

    raise HTTPException(status_code=501, detail=f"Training start not wired for {request.framework_id}")
