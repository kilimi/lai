#!/usr/bin/env python3
"""Extract datasets router handlers into service modules."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROUTER_PATH = REPO / "backend" / "app" / "routers" / "datasets.py"
SERVICES = REPO / "backend" / "app" / "services"

HEADER = '''"""Dataset domain services (extracted from datasets router)."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import BackgroundTasks, HTTPException, UploadFile
from PIL import Image
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.database import SessionLocal
from app.services.dataset_media_service import create_thumbnail_base64, set_random_image_as_logo
from app.services.dataset_video_service import video_progress_get, video_progress_set

logger = logging.getLogger(__name__)

'''

MERGE_HEADER = HEADER.replace(
    "from app.services.dataset_video_service import video_progress_get, video_progress_set\n",
    "",
) + "from app.task_stop import TaskStopped, check_task_stop, finalize_running_task, task_stop_requested\n"

FIFTYONE_HEADER = HEADER.replace(
    "from app.services.dataset_video_service import video_progress_get, video_progress_set\n",
    "",
)


def read_lines() -> list[str]:
    return ROUTER_PATH.read_text(encoding="utf-8").splitlines()


def extract_range(lines: list[str], start: int, end: int) -> str:
    return "\n".join(lines[start:end]) + "\n"


def dedent_router_handler(block: str, handler_name: str) -> str:
    """Turn router handler body into a module-level function."""
    block = re.sub(r"@router\.\w+\([^)]*\)\s*\n", "", block)
    block = re.sub(
        r"async def \w+\([^)]*\):",
        f"async def {handler_name}(...):  # signature filled in router\n    raise NotImplementedError",
        block,
        count=1,
    )
    return block


def main() -> None:
    lines = read_lines()

    # --- schemas 66:93 (0-indexed 66-93) ---
    schemas = extract_range(lines, 66, 93)
    (SERVICES / "dataset_schemas.py").write_text(
        '"""Pydantic request models for dataset APIs."""\nfrom __future__ import annotations\n\n'
        "from typing import List, Optional\n\nfrom pydantic import BaseModel\n\n" + schemas,
        encoding="utf-8",
    )

    # upload: lines 531-817 (body of upload_images)
    upload_body = extract_range(lines, 531, 817)
    upload_body = upload_body.replace("_create_thumbnail", "create_thumbnail_base64")
    upload_body = upload_body.replace("_set_random_image_as_logo", "set_random_image_as_logo")
    images_code = (
        HEADER
        + "\nasync def upload_dataset_images(db: Session, dataset_id: int, files: List[UploadFile], base_url: str) -> dict:\n"
        + "    try:\n"
        + upload_body
        + "\n\n"
        + "def list_dataset_images(db: Session, dataset_id: int, base_url: str) -> dict:\n"
        + "    try:\n"
        + extract_range(lines, 1136, 1166)
        + "\n\nasync def delete_dataset_image(db: Session, dataset_id: int, image_id: int) -> dict:\n"
        + "    try:\n"
        + extract_range(lines, 1177, 1240)
    )
    (SERVICES / "dataset_images_service.py").write_text(images_code, encoding="utf-8")

    # video extract body 850-1112
    video_body = extract_range(lines, 850, 1112)
    video_body = video_body.replace("_video_progress_set", "video_progress_set")
    video_body = video_body.replace("_set_random_image_as_logo", "set_random_image_as_logo")
    video_code = (
        HEADER
        + "\nasync def extract_frames_from_video_service(\n"
        + "    db: Session,\n    dataset_id: int,\n    video: UploadFile,\n    base_url: str,\n"
        + "    *, interval_seconds: float, frame_step: int, max_frames: int, job_id: str,\n"
        + "    collection_id: Optional[int], sequential_names: bool,\n"
        + "    resize_width: int, resize_height: int,\n) -> dict:\n"
        + video_body
    )
    (SERVICES / "dataset_video_extract_service.py").write_text(video_code, encoding="utf-8")

    # annotations block 1246-2844 — keep function defs, strip decorators
    ann_lines = lines[1244:2844]
    ann_text = "\n".join(ann_lines)
    ann_text = re.sub(r"@router\.\w+\([^\)]*\)\s*\n", "", ann_text)
    ann_text = ann_text.replace("from ..models import AnnotationFileImage", "from app.models import AnnotationFileImage")
    ann_text = ann_text.replace("from ..models import", "from app.models import")
    ann_text = ann_text.replace("from .annotation_db import", "from app.routers.annotation_db import")
    (SERVICES / "dataset_annotations_service.py").write_text(
        HEADER.replace("from fastapi import BackgroundTasks, HTTPException, UploadFile\n", "from fastapi import BackgroundTasks, HTTPException, UploadFile, Request\n")
        + ann_text,
        encoding="utf-8",
    )

    # merge task + process_merged 2846-3518
    merge_task = extract_range(lines, 2846, 3518)
    merge_task = merge_task.replace("from ..task_stop import", "from app.task_stop import")
    merge_endpoint = extract_range(lines, 3528, 3618)
    merge_endpoint = merge_endpoint.replace("await merge_annotation_files_task", "await merge_annotation_files_task")
    (SERVICES / "dataset_annotation_merge_service.py").write_text(
        MERGE_HEADER + merge_task + "\n\nasync def start_annotation_merge(\n    db: Session,\n    dataset_id: int,\n    request,\n    background_tasks: BackgroundTasks,\n) -> dict:\n    try:\n"
        + merge_endpoint,
        encoding="utf-8",
    )

    # fiftyone 3626-end
    fo_text = extract_range(lines, 3626, len(lines))
    fo_text = fo_text.replace("@router.post", "# was router.post")
    fo_text = re.sub(
        r"async def view_annotations_in_fiftyone\([^)]*\):",
        "async def view_annotations_in_fiftyone(db: Session, dataset_id: int, body) -> dict:",
        fo_text,
        count=1,
    )
    (SERVICES / "dataset_fiftyone_service.py").write_text(FIFTYONE_HEADER + fo_text, encoding="utf-8")

    print("Extracted service modules to", SERVICES)


if __name__ == "__main__":
    main()
