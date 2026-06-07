"""Dispatch single-image YOLO test inference to the celery_worker Ultralytics runtime."""
from __future__ import annotations

import base64
import logging
import os
import shutil
import uuid
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

USE_CELERY = os.environ.get("USE_CELERY", "true").lower() == "true"


def run_yolo_test_inference_via_celery(
    *,
    task_id: int,
    tmp_image_path: str,
    model_path: str,
    class_names: list,
    conf_threshold: float = 0.25,
    device: str = "cpu",
    timeout: int = 180,
) -> JSONResponse:
    if not USE_CELERY:
        raise HTTPException(
            status_code=503,
            detail="YOLO test inference requires Celery (USE_CELERY=true).",
        )

    from app.ml.celery_dispatch import GPU_QUEUE, send_gpu_task

    try:
        async_result = send_gpu_task(
            "app.tasks.evaluation_tasks.yolo_test_inference",
            args=[tmp_image_path, model_path, class_names],
            kwargs={
                "conf_threshold": conf_threshold,
                "device": device,
            },
            queue=GPU_QUEUE,
        )
        worker_result = async_result.get(timeout=timeout)
    except Exception as exc:
        logger.error("Celery yolo_test_inference failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Inference error: {exc}",
        ) from exc

    if worker_result.get("error"):
        raise HTTPException(
            status_code=500,
            detail=f"Inference error: {worker_result['error']}",
        )

    static_dir = Path("static/inference_results")
    static_dir.mkdir(parents=True, exist_ok=True)
    annotated_filename = f"annotated_{task_id}_{uuid.uuid4().hex[:8]}.jpg"
    annotated_static_path = static_dir / annotated_filename

    annotated_b64 = worker_result.get("annotated_jpeg_base64")
    if annotated_b64:
        annotated_static_path.write_bytes(base64.b64decode(annotated_b64))
    else:
        shutil.copy2(tmp_image_path, str(annotated_static_path))

    try:
        os.unlink(tmp_image_path)
    except OSError:
        pass

    return JSONResponse(
        {
            "success": True,
            "result": {
                "predictions": worker_result.get("predictions", []),
                "image_url": f"/static/inference_results/{annotated_filename}",
            },
        }
    )
