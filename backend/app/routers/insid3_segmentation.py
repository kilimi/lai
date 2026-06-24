"""FastAPI proxy for INSID3 segmentation (sam_service /segment/insid3)."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from app.services.media_bytes import fetch_image_b64, resolve_media_url

router = APIRouter()
logger = logging.getLogger(__name__)
SAM_SERVICE_URL = os.environ.get("SAM_SERVICE_URL", "http://sam_service:8081")


async def _sam_health() -> tuple[bool, dict | None]:
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{SAM_SERVICE_URL}/health")
            if r.status_code == 200:
                return True, r.json()
    except Exception:
        pass
    return False, None


async def _fetch_image_b64(image_url: str) -> str | None:
    return fetch_image_b64(image_url)


async def _enrich_references(refs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ref in refs:
        item = dict(ref)
        if not item.get("imageB64"):
            url = resolve_media_url(item.get("imageUrl"))
            if url:
                b64 = await _fetch_image_b64(url)
                if b64:
                    item["imageB64"] = b64
                    item.pop("imageUrl", None)
        out.append(item)
    return out


async def _post_sam(path: str, body: dict, timeout: float = 120.0) -> dict:
    url = f"{SAM_SERVICE_URL}{path}"
    if "insid3" in path:
        logger.info(
            "[INSID3] backend -> sam_service POST %s refs=%s target_b64=%s",
            path,
            len(body.get("references") or []),
            bool(body.get("targetImageB64")),
        )
    try:
        import httpx

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body)
            if "insid3" in path:
                logger.info(
                    "[INSID3] sam_service responded %s for %s",
                    resp.status_code,
                    path,
                )
            if resp.status_code >= 400:
                raise HTTPException(status_code=resp.status_code, detail=resp.text)
            return resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach sam service: {e}") from e


class Insid3ReferencePayload(BaseModel):
    imageUrl: Optional[str] = None
    imageB64: Optional[str] = None
    polygon: List[List[float]]
    width: Optional[int] = None
    height: Optional[int] = None
    imageName: Optional[str] = None
    annotationId: Optional[str] = None
    className: Optional[str] = None


class Insid3PreviewRequest(BaseModel):
    references: List[Insid3ReferencePayload] = Field(..., min_length=1)
    targetImageUrl: Optional[str] = None
    targetImageB64: Optional[str] = None
    targetWidth: Optional[int] = None
    targetHeight: Optional[int] = None
    image_size: int = 768
    model_size: str = "base"
    min_area: float = 0


class Insid3PropagateRequest(BaseModel):
    dataset_id: int
    project_id: Optional[int] = None
    collection_id: Optional[int] = None
    class_name: str
    class_color: Optional[str] = None
    references: List[Insid3ReferencePayload] = Field(..., min_length=1)
    exclude_reference_images: bool = True
    target_image_names: Optional[List[str]] = None
    image_size: int = 768
    model_size: str = "base"
    min_area: float = 0
    task_name: Optional[str] = None


@router.get("/segment/ready/insid3")
async def segment_ready_insid3():
    ok, body = await _sam_health()
    insid3 = (body or {}).get("insid3") or {}
    if ok and (body or {}).get("insid3_available"):
        return {"available": True}
    detail = "INSID3 not available"
    if insid3.get("weights_available"):
        err = insid3.get("error")
        detail = f"INSID3 setup failed: {err}" if err else "INSID3 setup failed (see sam_service logs)"
    elif not insid3.get("weights_available"):
        detail = "DINOv3 weights missing in DINOV3_WEIGHTS_HOST_PATH"
    raise HTTPException(status_code=503, detail=detail)


@router.post("/segment/insid3")
async def proxy_insid3_preview(body: Insid3PreviewRequest):
    logger.info(
        "[INSID3] preview request from UI: refs=%s target_b64=%s min_area=%s",
        len(body.references),
        bool(body.targetImageB64),
        body.min_area,
    )
    refs = await _enrich_references([r.model_dump(exclude_none=True) for r in body.references])
    payload: Dict[str, Any] = {
        "references": refs,
        "image_size": body.image_size,
        "model_size": body.model_size,
        "min_area": body.min_area,
    }
    if body.targetImageB64:
        payload["targetImageB64"] = body.targetImageB64
    else:
        url = resolve_media_url(body.targetImageUrl)
        if url:
            b64 = await _fetch_image_b64(url)
            if b64:
                payload["targetImageB64"] = b64
            else:
                payload["targetImageUrl"] = url
    if body.targetWidth:
        payload["targetWidth"] = body.targetWidth
    if body.targetHeight:
        payload["targetHeight"] = body.targetHeight
    return await _post_sam("/segment/insid3", payload)


@router.post("/segment/insid3/propagate/start")
async def start_insid3_propagate(body: Insid3PropagateRequest, background_tasks: BackgroundTasks):
    from app.database import SessionLocal
    from app import models
    from app.task_dispatch import ensure_inline_dispatch_allowed, use_celery_enabled

    db = SessionLocal()
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == body.dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        task_name = body.task_name or f"Find similar ({body.class_name})"
        propagate_task = models.Task(
            name=task_name,
            task_type="insid3_propagate",
            status="pending",
            progress=0.0,
            project_id=body.project_id or dataset.project_id,
            task_metadata={
                "dataset_id": body.dataset_id,
                "collection_id": body.collection_id,
                "class_name": body.class_name,
                "class_color": body.class_color,
                "references": [r.model_dump(exclude_none=True) for r in body.references],
                "exclude_reference_images": body.exclude_reference_images,
                "target_image_names": body.target_image_names,
                "image_size": body.image_size,
                "model_size": body.model_size,
                "min_area": body.min_area,
                "stage": "queued",
                "results": {},
            },
        )
        db.add(propagate_task)
        db.commit()
        db.refresh(propagate_task)
        task_id = propagate_task.id
        logger.info(
            "[INSID3] propagate task %s queued (dataset=%s refs=%s)",
            task_id,
            body.dataset_id,
            len(body.references),
        )

        if use_celery_enabled():
            from app.tasks.insid3_tasks import run_insid3_propagate

            celery_result = run_insid3_propagate.delay(task_id)
            propagate_task.task_metadata = {
                **(propagate_task.task_metadata or {}),
                "celery_task_id": celery_result.id,
            }
            db.commit()
        else:
            ensure_inline_dispatch_allowed("INSID3 propagate")
            from app.services.insid3_propagate_service import run_insid3_propagate_work

            background_tasks.add_task(run_insid3_propagate_work, task_id)

        return {
            "success": True,
            "task_id": task_id,
            "message": "INSID3 propagate started",
        }
    finally:
        db.close()
