#!/usr/bin/env python3
"""Replace datasets router bulk handlers with thin service delegates."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTER = ROOT / "backend" / "app" / "routers" / "datasets.py"
KEEP_LINES = 522

IMPORT_BLOCK = '''
from app.services.dataset_schemas import (
    MergeAnnotationFilesRequest,
    MoveDatasetRequest,
    ViewFiftyOneRequest,
)
from app.services.dataset_images_service import (
    delete_dataset_image,
    list_dataset_images,
    upload_dataset_images,
)
from app.services.dataset_video_extract_service import extract_frames_from_video_service
from app.services import dataset_annotations_service as ann_svc
from app.services.dataset_annotation_merge_service import start_annotation_merge
from app.services.dataset_fiftyone_service import view_annotations_in_fiftyone
'''

TAIL = '''
@router.post("/datasets/{dataset_id}/images")
async def upload_images(
    request: Request,
    dataset_id: int,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    return await upload_dataset_images(
        db, dataset_id, files, public_request_base_url(request)
    )


@router.post("/datasets/{dataset_id}/video-extract")
async def extract_frames_from_video(
    request: Request,
    dataset_id: int,
    video: UploadFile = File(...),
    interval_seconds: float = Form(1.0),
    frame_step: int = Form(1),
    max_frames: int = Form(0),
    job_id: str = Form(""),
    collection_id: Optional[int] = Form(None),
    sequential_names: bool = Form(False),
    resize_width: int = Form(0),
    resize_height: int = Form(0),
    db: Session = Depends(get_db),
):
    return await extract_frames_from_video_service(
        db,
        dataset_id,
        video,
        public_request_base_url(request),
        interval_seconds=interval_seconds,
        frame_step=frame_step,
        max_frames=max_frames,
        job_id=job_id,
        collection_id=collection_id,
        sequential_names=sequential_names,
        resize_width=resize_width,
        resize_height=resize_height,
    )


@router.get("/datasets/{dataset_id}/video-extract/progress/{job_id}")
def get_video_extract_progress(dataset_id: int, job_id: str):
    entry = _video_progress_get(job_id)
    if entry is None:
        return {
            "success": True,
            "data": {
                "job_id": job_id,
                "stage": "unknown",
                "extracted": 0,
                "total": 0,
                "percent": 0.0,
            },
        }
    if entry.get("dataset_id") not in (None, dataset_id):
        raise HTTPException(status_code=404, detail="Job does not belong to this dataset")
    return {"success": True, "data": entry}


@router.get("/datasets/{dataset_id}/images")
def get_dataset_images(request: Request, dataset_id: int, db: Session = Depends(get_db)):
    return list_dataset_images(db, dataset_id, public_request_base_url(request))


@router.delete("/datasets/{dataset_id}/images/{image_id}")
async def delete_image(dataset_id: int, image_id: int, db: Session = Depends(get_db)):
    return await delete_dataset_image(db, dataset_id, image_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/coverage")
def get_annotation_file_coverage(
    dataset_id: int, annotation_file_id: str, db: Session = Depends(get_db)
):
    return ann_svc.get_annotation_file_coverage(db, dataset_id, annotation_file_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/collection-counts")
def get_annotation_file_collection_counts(
    dataset_id: int, annotation_file_id: str, db: Session = Depends(get_db)
):
    return ann_svc.get_annotation_file_collection_counts(db, dataset_id, annotation_file_id)


@router.get("/datasets/{dataset_id}/annotations/coverage")
def get_dataset_annotations_coverage(dataset_id: int, db: Session = Depends(get_db)):
    return ann_svc.get_dataset_annotations_coverage(db, dataset_id)


@router.post("/datasets/{dataset_id}/import-annotations")
async def import_annotations(
    dataset_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.import_annotations(db, dataset_id, background_tasks, file)


@router.post("/datasets/{dataset_id}/create-annotation-task")
async def create_annotation_processing_task(
    dataset_id: int,
    file: UploadFile = File(...),
    annotation_type: Optional[str] = Form(None),
    task_name: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    return await ann_svc.create_annotation_processing_task(
        db, dataset_id, file, annotation_type, task_name
    )


@router.delete("/datasets/{dataset_id}/annotations/{annotation_id}")
async def delete_dataset_annotation(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.delete_dataset_annotation(db, dataset_id, annotation_id)


@router.get("/datasets/{dataset_id}/annotations")
async def get_dataset_annotations(dataset_id: int, db: Session = Depends(get_db)):
    return await ann_svc.get_dataset_annotations(db, dataset_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_id}")
async def get_dataset_annotation(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.get_dataset_annotation(db, dataset_id, annotation_id)


@router.get("/datasets/{dataset_id}/annotations/summary")
async def get_dataset_annotations_summary(dataset_id: int, db: Session = Depends(get_db)):
    return await ann_svc.get_dataset_annotations_summary(db, dataset_id)


@router.get("/datasets/{dataset_id}/annotations/list")
async def get_dataset_annotations_list(
    dataset_id: int,
    page: int = 1,
    limit: int = 1000,
    annotation_file_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    return await ann_svc.get_dataset_annotations_list(
        db, dataset_id, page, limit, annotation_file_id
    )


@router.get("/datasets/{dataset_id}/annotations/{annotation_id}/content")
async def get_dataset_annotation_content(
    dataset_id: int,
    annotation_id: str,
    include_images: bool = True,
    include_annotations: bool = True,
    db: Session = Depends(get_db),
):
    return await ann_svc.get_dataset_annotation_content(
        db,
        dataset_id,
        annotation_id,
        include_images=include_images,
        include_annotations=include_annotations,
    )


@router.post("/datasets/{dataset_id}/annotations/{annotation_id}/duplicate")
async def duplicate_annotation_file(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.duplicate_annotation_file(db, dataset_id, annotation_id)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/rename")
async def rename_annotation_file(
    dataset_id: int,
    annotation_id: str,
    new_name: str = Form(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.rename_annotation_file(db, dataset_id, annotation_id, new_name)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/tags")
async def update_annotation_tags(
    dataset_id: int,
    annotation_id: str,
    tags: List[str] = Form(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.update_annotation_tags(db, dataset_id, annotation_id, tags)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/content")
async def update_annotation_content(
    dataset_id: int,
    annotation_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.update_annotation_content(db, dataset_id, annotation_id, file)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/class/rename")
async def rename_annotation_class(
    dataset_id: int, annotation_id: str, body: dict, db: Session = Depends(get_db)
):
    return await ann_svc.rename_annotation_class(db, dataset_id, annotation_id, body)


@router.delete("/datasets/{dataset_id}/annotations/{annotation_id}/class/{class_name}")
async def delete_annotation_class(
    dataset_id: int, annotation_id: str, class_name: str, db: Session = Depends(get_db)
):
    return await ann_svc.delete_annotation_class(db, dataset_id, annotation_id, class_name)


@router.patch("/datasets/{dataset_id}/annotations/{annotation_id}/image/{image_name}")
async def update_single_image_annotations(
    dataset_id: int,
    annotation_id: str,
    image_name: str,
    request: dict,
    db: Session = Depends(get_db),
):
    return await ann_svc.update_single_image_annotations(
        db, dataset_id, annotation_id, image_name, request
    )


@router.post("/datasets/{dataset_id}/annotations/merge")
async def merge_annotation_files(
    dataset_id: int,
    request: MergeAnnotationFilesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return await start_annotation_merge(db, dataset_id, request, background_tasks)


@router.post("/datasets/{dataset_id}/annotations/view-fiftyone")
async def view_annotations_in_fiftyone_endpoint(
    dataset_id: int,
    body: ViewFiftyOneRequest,
    db: Session = Depends(get_db),
):
    return await view_annotations_in_fiftyone(db, dataset_id, body)
'''


def patch_head(head: str) -> str:
    # Drop inline pydantic models (now in dataset_schemas)
    start = head.find("\nclass MergeStrategyConfig")
    end = head.find("\n@router.post(\"/datasets/\", response_model=schemas.Dataset)")
    if start != -1 and end != -1:
        head = head[:start] + head[end:]

    if "from app.services.dataset_schemas import" not in head:
        anchor = "from app.services.dataset_video_service import video_progress_get, video_progress_set\n"
        head = head.replace(anchor, anchor + IMPORT_BLOCK)

    # Trim imports only used by extracted handlers
    for line in (
        "from pydantic import BaseModel\n",
        "import base64\n",
        "import tempfile\n",
        "import subprocess\n",
        "import time\n",
        "import asyncio\n",
        "import threading\n",
        "from PIL import Image\n",
        "import io\n",
        "import uuid\n",
        "import cv2\n",
        "import numpy as np\n",
        "from sqlalchemy import func\n",
        "from ..database import get_db, SessionLocal\n",
    ):
        head = head.replace(line, "")
    head = head.replace(
        "from ..database import get_db, SessionLocal\n",
        "from ..database import get_db\n",
    )
    if "from ..database import get_db\n" not in head:
        head = head.replace(
            "from ..http_utils import public_request_base_url\n",
            "from ..database import get_db\nfrom ..http_utils import public_request_base_url\n",
        )
    return head


def main() -> None:
    lines = ROUTER.read_text(encoding="utf-8").splitlines(keepends=True)
    head = "".join(lines[:KEEP_LINES])
    head = patch_head(head)
    ROUTER.write_text(head + TAIL, encoding="utf-8")
    print(f"spliced {ROUTER} -> {len((head + TAIL).splitlines())} lines")


if __name__ == "__main__":
    main()
