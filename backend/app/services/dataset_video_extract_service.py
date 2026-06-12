"""Dataset domain services (extracted from datasets router)."""
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
from app.services.dataset_media_service import set_random_image_as_logo
from app.services.dataset_video_service import video_progress_get, video_progress_set

logger = logging.getLogger(__name__)


async def extract_frames_from_video_service(
    db: Session,
    dataset_id: int,
    video: UploadFile,
    base_url: str,
    *, interval_seconds: float, frame_step: int, max_frames: int, job_id: str,
    collection_id: Optional[int], sequential_names: bool,
    resize_width: int, resize_height: int,
) -> dict:
    def _progress(**fields) -> None:
        video_progress_set(job_id, **fields)

    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        # Validate video type
        name = (video.filename or "").lower()
        if not any(name.endswith(ext) for ext in (".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v", ".wmv")):
            raise HTTPException(status_code=400, detail="Invalid video file. Supported: MP4, AVI, MOV, MKV, WebM, M4V, WMV")

        if interval_seconds <= 0:
            raise HTTPException(status_code=400, detail="interval_seconds must be positive")
        if frame_step <= 0:
            raise HTTPException(status_code=400, detail="frame_step must be >= 1")
        if max_frames < 0:
            raise HTTPException(status_code=400, detail="max_frames must be >= 0")

        project_id = dataset.project_id
        dataset_dir = Path("projects") / str(project_id) / str(dataset_id) / "images"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        # When sequential_names is requested, frames are stored in a
        # collection-specific subdirectory so that two collections (e.g. RGB
        # and Thermo) can both have 0001.jpg without colliding on disk.
        # file_name in the DB stays "0001.jpg" for both so annotation
        # layer-switching can match frames across collections by name.
        _sequential_subdir: Optional[Path] = None  # resolved after collection is known

        # Pick the target collection. Prefer an explicit `collection_id` from
        # the client (the tab the user was viewing when they clicked Upload
        # Video) and fall back to the dataset's default collection. This
        # matches the image-upload flow, which already writes to whatever
        # collection tab is active.
        target_collection: Optional[models.ImageCollection] = None
        if collection_id is not None:
            target_collection = db.query(models.ImageCollection).filter(
                models.ImageCollection.id == collection_id,
                models.ImageCollection.dataset_id == dataset_id,
            ).first()
            if not target_collection:
                raise HTTPException(
                    status_code=400,
                    detail=f"collection_id {collection_id} does not belong to dataset {dataset_id}",
                )

        if target_collection is None:
            target_collection = db.query(models.ImageCollection).filter(
                models.ImageCollection.dataset_id == dataset_id,
                models.ImageCollection.is_default == True
            ).first()
        if not target_collection:
            target_collection = models.ImageCollection(
                dataset_id=dataset_id,
                name="RGB Images",
                description="Default image collection",
                is_default=True
            )
            db.add(target_collection)
            db.flush()

        # Now that target_collection is resolved, pin the write directory.
        if sequential_names:
            _sequential_subdir = dataset_dir / f"c{target_collection.id}"
            _sequential_subdir.mkdir(parents=True, exist_ok=True)

        _progress(stage="receiving", extracted=0, total=0, percent=0.0)
        # Stream the upload directly to disk — avoids holding the entire video in RAM.
        # For large files (GBs) this is the single biggest latency fix.
        video_base = os.path.splitext(os.path.basename(video.filename or "video"))[0]
        temp_video = dataset_dir / f"_temp_{uuid.uuid4().hex[:12]}_{os.path.basename(video.filename or 'video')}"
        try:
            with open(temp_video, "wb") as f:
                while True:
                    chunk = await video.read(1 << 20)  # 1 MiB chunks
                    if not chunk:
                        break
                    f.write(chunk)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save video: {e}")

        cap = cv2.VideoCapture(str(temp_video))
        if not cap.isOpened():
            if temp_video.exists():
                temp_video.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Could not open video file")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_source_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        # CAP_PROP_FRAME_COUNT is unreliable for many MP4 files (H.265, VFR,
        # camera-recorded).  Fall back to the seek-to-end trick: MP4 stores a
        # frame index in the moov atom so the seek is O(1) and does not decode
        # any video data.
        if total_source_frames <= 0:
            try:
                cap.set(cv2.CAP_PROP_POS_AVI_RATIO, 1.0)
                total_source_frames = int(cap.get(cv2.CAP_PROP_POS_FRAMES) or 0)
            except Exception:
                total_source_frames = 0
            finally:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

        # Two sampling modes:
        # 1) frame_step > 1  => keep every Nth source frame (user-friendly for
        #    large skips like "every 100th frame").
        # 2) frame_step == 1 => fallback to time-based interval_seconds.
        frame_interval = (
            max(1, int(frame_step))
            if frame_step > 1
            else max(1, int(round(fps * interval_seconds)))
        )

        # Compute the expected number of output frames up front so the progress
        # bar has a real denominator.
        if total_source_frames > 0:
            projected_extractions = (total_source_frames + frame_interval - 1) // frame_interval
        else:
            projected_extractions = 0
        if max_frames > 0:
            if projected_extractions > 0:
                projected_extractions = min(projected_extractions, max_frames)
            else:
                projected_extractions = max_frames

        _progress(
            stage="extracting",
            extracted=0,
            total=projected_extractions,
            percent=0.0,
            fps=fps,
            frame_interval=frame_interval,
            source_frames=total_source_frames,
            frame_step=frame_step,
        )

        frame_idx = 0
        extracted = 0
        uploaded_images = []
        last_progress_push = time.time()

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                if max_frames > 0 and extracted >= max_frames:
                    break
                if frame_idx % frame_interval != 0:
                    frame_idx += 1
                    continue
                extracted += 1
                height, width = frame.shape[:2]
                if sequential_names:
                    # Use collection subdirectory — no collision avoidance needed
                    # because each collection has its own folder.
                    bare_filename = f"{extracted:04d}.jpg"
                    write_dir = _sequential_subdir  # type: ignore[assignment]
                    file_path = write_dir / bare_filename
                    final_filename = bare_filename  # stored in DB as-is for cross-collection matching
                    url_path = f"c{target_collection.id}/{bare_filename}"
                else:
                    final_filename = f"{video_base}_frame_{extracted:06d}.jpg"
                    write_dir = dataset_dir
                    file_path = write_dir / final_filename
                    counter = 1
                    while file_path.exists():
                        final_filename = f"{video_base}_frame_{extracted:06d}_{counter}.jpg"
                        file_path = write_dir / final_filename
                        counter += 1
                    url_path = final_filename
                # Resize frame if a target resolution was requested
                if resize_width > 0 and resize_height > 0:
                    frame = cv2.resize(frame, (resize_width, resize_height), interpolation=cv2.INTER_AREA)
                    height, width = resize_height, resize_width
                elif resize_width > 0:
                    scale = resize_width / width
                    frame = cv2.resize(frame, (resize_width, int(height * scale)), interpolation=cv2.INTER_AREA)
                    height, width = frame.shape[:2]
                elif resize_height > 0:
                    scale = resize_height / height
                    frame = cv2.resize(frame, (int(width * scale), resize_height), interpolation=cv2.INTER_AREA)
                    height, width = frame.shape[:2]
                # JPEG (quality 90) is ~8x faster to encode and 5-10x smaller than PNG
                success = cv2.imwrite(str(file_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
                if not success:
                    continue
                # Get file size from stat — avoids re-reading the whole file just for len()
                file_size = file_path.stat().st_size
                relative_url = f"/static/projects/{project_id}/{dataset_id}/images/{url_path}"
                db_image = models.Image(
                    dataset_id=dataset_id,
                    collection_id=target_collection.id,
                    file_name=final_filename,
                    file_size=file_size,
                    width=int(width),
                    height=int(height),
                    url=relative_url,
                    thumbnail_url=relative_url,
                    annotations_count=0
                )
                db.add(db_image)
                uploaded_images.append(db_image)
                frame_idx += 1

                # Throttle progress updates — ~3 Hz is plenty for a smooth bar.
                now = time.time()
                if job_id and (now - last_progress_push >= 0.3):
                    pct = (extracted / projected_extractions * 100.0) if projected_extractions > 0 else 0.0
                    _progress(
                        stage="extracting",
                        extracted=extracted,
                        total=projected_extractions,
                        percent=min(99.0, pct),
                    )
                    last_progress_push = now
        finally:
            cap.release()
            if temp_video.exists():
                temp_video.unlink(missing_ok=True)

        _progress(stage="saving", extracted=extracted, total=projected_extractions or extracted, percent=99.0)

        # Avoid an extra COUNT(*) — image_count was already accurate before this upload.
        dataset.image_count = (dataset.image_count or 0) + len(uploaded_images)
        db.commit()
        set_random_image_as_logo(dataset, db, base_url)

        response_images = []
        for img in uploaded_images:
            url = f"{base_url}{img.url}" if img.url.startswith("/") else img.url
            thumbnail_url = f"{base_url}{img.thumbnail_url}?thumb=300" if img.thumbnail_url.startswith("/") else img.thumbnail_url
            response_images.append({
                "id": str(img.id),
                "datasetId": str(dataset_id),
                "fileName": img.file_name,
                "fileSize": img.file_size,
                "width": img.width,
                "height": img.height,
                "url": url,
                "thumbnailUrl": thumbnail_url,
                "uploadedAt": img.uploaded_at.isoformat(),
                "annotationsCount": img.annotations_count
            })

        _progress(stage="done", extracted=extracted, total=extracted, percent=100.0, uploaded=len(uploaded_images))

        return {
            "success": True,
            "data": {
                "uploaded": len(uploaded_images),
                "overwritten": 0,
                "images": response_images
            }
        }
    except HTTPException as http_exc:
        _progress(stage="error", error=str(http_exc.detail), percent=0.0)
        raise
    except Exception as e:
        if db:
            db.rollback()
        _progress(stage="error", error=str(e), percent=0.0)
        raise HTTPException(status_code=500, detail=str(e))
