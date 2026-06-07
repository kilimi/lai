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
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.services.dataset_schemas import ViewFiftyOneRequest

logger = logging.getLogger(__name__)

def _sanitize_fiftyone_field_name(name: str) -> str:
    """Sanitize annotation file name for use as FiftyOne field name."""
    base = os.path.splitext(name)[0] if name else "annotations"
    base = re.sub(r"[^a-zA-Z0-9_]", "_", base)
    return f"predictions_{base}" if base else "predictions"


def _depth_like_collection_name(name: Optional[str]) -> bool:
    if not name:
        return False
    n = name.lower()
    return bool(re.search(r"\bdepth\b", n)) or "depth map" in n or "depth-map" in n


def _effective_project_id(dataset: models.Dataset, images: List[models.Image]) -> int:
    if dataset.project_id:
        return int(dataset.project_id)
    for img in images:
        u = (img.url or "").replace("\\", "/")
        m = re.search(r"/projects/(\d+)/", u)
        if m:
            return int(m.group(1))
    return 0


def _pick_default_fiftyone_collection_id(db: Session, dataset_id: int) -> Optional[int]:
    cols = (
        db.query(models.ImageCollection)
        .filter(models.ImageCollection.dataset_id == dataset_id)
        .order_by(models.ImageCollection.is_default.desc(), models.ImageCollection.created_at.asc())
        .all()
    )
    if not cols:
        return None
    for c in cols:
        if c.is_default and not _depth_like_collection_name(c.name):
            return int(c.id)
    for c in cols:
        n = (c.name or "").lower()
        if ("rgb" in n or "color" in n or "visible" in n) and not _depth_like_collection_name(c.name):
            return int(c.id)
    for c in cols:
        if not _depth_like_collection_name(c.name):
            return int(c.id)
    return int(cols[0].id)


def _remap_annotation_image_to_layer(
    src: models.Image,
    target_collection_id: int,
    all_images: List[models.Image],
) -> models.Image:
    if src.collection_id == target_collection_id:
        return src
    if src.group_id:
        for t in all_images:
            if t.collection_id == target_collection_id and t.group_id and t.group_id == src.group_id:
                return t
    base = os.path.splitext(src.file_name or "")[0].lower()
    for t in all_images:
        if t.collection_id != target_collection_id:
            continue
        tb = os.path.splitext(t.file_name or "")[0].lower()
        if tb == base:
            return t
    return src


def _filesystem_path_for_image(
    img: models.Image,
    project_id: int,
    dataset_id: int,
    *,
    collection_id: Optional[int] = None,
) -> Optional[Path]:
    """Resolve on-disk image path (collection subdirs, URL tails, project scan)."""
    pid = int(project_id) if project_id else None
    coll = collection_id
    if coll is None and getattr(img, "collection_id", None) is not None:
        coll = int(img.collection_id)
    return resolve_dataset_image_path_from_models(
        img,
        dataset_id=int(dataset_id),
        project_id=pid,
        collection_id=coll,
    )


def _can_resolve_fiftyone_image(
    img: models.Image,
    project_id: int,
    dataset_id: int,
    *,
    collection_id: Optional[int] = None,
) -> bool:
    return _filesystem_path_for_image(
        img, project_id, dataset_id, collection_id=collection_id
    ) is not None


def _annotation_bbox_pixel_xywh(
    ann: models.Annotation,
    img_width: float,
    img_height: float,
) -> Optional[List[float]]:
    """
    COCO pixel bbox [x, y, w, h] from DB columns or legacy JSON.

    ``bbox_*`` columns are usually normalized 0–1; auto-annotate may store pixels.
    """
    w = float(img_width or 1) or 1.0
    h = float(img_height or 1) or 1.0

    if (
        ann.bbox_x is not None
        and ann.bbox_y is not None
        and ann.bbox_width is not None
        and ann.bbox_height is not None
    ):
        x, y, bw, bh = (
            float(ann.bbox_x),
            float(ann.bbox_y),
            float(ann.bbox_width),
            float(ann.bbox_height),
        )
        if max(x, y, bw, bh) <= 1.0:
            return [x * w, y * h, bw * w, bh * h]
        return [x, y, bw, bh]

    if ann.bbox and isinstance(ann.bbox, list) and len(ann.bbox) >= 4:
        x, y, bw, bh = (float(v) for v in ann.bbox[:4])
        if max(x, y, bw, bh) <= 1.0:
            return [x * w, y * h, bw * w, bh * h]
        return [x, y, bw, bh]

    return None


def _fiftyone_bbox_norm_from_annotation(
    ann: models.Annotation,
    img_width: float,
    img_height: float,
) -> Optional[List[float]]:
    """FiftyOne Detection.bounding_box: normalized [x, y, w, h] in [0, 1]."""
    w = float(img_width or 1) or 1.0
    h = float(img_height or 1) or 1.0
    pixel = _annotation_bbox_pixel_xywh(ann, w, h)
    if pixel is not None:
        return [pixel[0] / w, pixel[1] / h, pixel[2] / w, pixel[3] / h]

    seg = ann.segmentation
    if not seg:
        return None

    # COCO segmentation: [[x1,y1,...]] or flat [x1,y1,...]
    rings: List[List[float]] = []
    if isinstance(seg, list) and seg:
        if seg and isinstance(seg[0], (int, float)):
            rings.append([float(v) for v in seg])
        else:
            for ring in seg:
                if isinstance(ring, list) and len(ring) >= 6:
                    rings.append([float(v) for v in ring])

    xs: List[float] = []
    ys: List[float] = []
    for ring in rings:
        for i in range(0, len(ring) - 1, 2):
            xs.append(ring[i])
            ys.append(ring[i + 1])
    if not xs:
        return None

    if max(xs + ys) <= 1.0:
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        return [min_x, min_y, max(0.0, max_x - min_x), max(0.0, max_y - min_y)]

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return [
        min_x / w,
        min_y / h,
        max(0.0, max_x - min_x) / w,
        max(0.0, max_y - min_y) / h,
    ]


# was router.post("/datasets/{dataset_id}/annotations/view-fiftyone")
async def view_annotations_in_fiftyone(
    db: Session, dataset_id: int, body: ViewFiftyOneRequest
) -> dict:
    """Open selected annotation files in FiftyOne, shown as predictions (one field per file)."""
    if not body.annotation_file_ids:
        raise HTTPException(status_code=400, detail="Select at least one annotation file")

    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    images = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).all()
    if not images:
        raise HTTPException(status_code=400, detail="No images in dataset")

    eff_project_id = _effective_project_id(dataset, images)
    by_id: dict = {str(img.id): img for img in images}

    target_col_id: Optional[int] = body.image_collection_id
    if target_col_id is not None:
        col = (
            db.query(models.ImageCollection)
            .filter(
                models.ImageCollection.id == target_col_id,
                models.ImageCollection.dataset_id == dataset_id,
            )
            .first()
        )
        if not col:
            raise HTTPException(status_code=400, detail="Invalid image collection for this dataset")
    else:
        target_col_id = _pick_default_fiftyone_collection_id(db, dataset_id)
        if target_col_id is None:
            raise HTTPException(status_code=400, detail="No image collections found for this dataset")

    # Per annotation file: field_name -> { display_image_id -> [ {label, bbox, confidence} ] }
    predictions_by_field = {}

    for af_id in body.annotation_file_ids:
        af = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == af_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        if not af:
            continue
        field_name = _sanitize_fiftyone_field_name(af.name or af_id[:8])
        annotations = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == af_id,
            models.Annotation.dataset_id == dataset_id
        ).all()

        by_image = {}
        for ann in annotations:
            src_key = str(ann.image_id)
            src = by_id.get(src_key)
            if not src:
                continue
            disp = _remap_annotation_image_to_layer(src, int(target_col_id), images)
            disp_key = str(disp.id)

            w_src = float(src.width or 1) or 1.0
            h_src = float(src.height or 1) or 1.0
            w_disp = float(disp.width or 1) or 1.0
            h_disp = float(disp.height or 1) or 1.0

            pixel = _annotation_bbox_pixel_xywh(ann, w_src, h_src)
            if pixel is None:
                bbox_norm = _fiftyone_bbox_norm_from_annotation(ann, w_disp, h_disp)
                if bbox_norm is None:
                    continue
            else:
                if src.id != disp.id:
                    sx = w_disp / w_src
                    sy = h_disp / h_src
                    pixel = [
                        pixel[0] * sx,
                        pixel[1] * sy,
                        pixel[2] * sx,
                        pixel[3] * sy,
                    ]
                bbox_norm = [
                    pixel[0] / w_disp,
                    pixel[1] / h_disp,
                    pixel[2] / w_disp,
                    pixel[3] / h_disp,
                ]

            label = ann.category or "unknown"
            conf = float(ann.confidence) if ann.confidence is not None else 1.0
            if disp_key not in by_image:
                by_image[disp_key] = []
            by_image[disp_key].append({"label": label, "bbox": bbox_norm, "confidence": conf})

        predictions_by_field[field_name] = by_image

    if not predictions_by_field:
        raise HTTPException(status_code=400, detail="No valid annotation files or annotations found")

    needed_ids = set()
    for _fn, by_img in predictions_by_field.items():
        needed_ids.update(by_img.keys())

    image_dict = {}
    for iid in needed_ids:
        img = by_id.get(iid)
        if not img:
            continue
        fs = _filesystem_path_for_image(
            img, eff_project_id, dataset_id, collection_id=target_col_id
        )
        entry = {
            "file_name": img.file_name,
            "width": img.width or 1,
            "height": img.height or 1,
        }
        if fs is not None:
            entry["fs_path"] = str(fs)
        image_dict[iid] = entry

    if not any(
        iid in by_id
        and _can_resolve_fiftyone_image(
            by_id[iid], eff_project_id, dataset_id, collection_id=target_col_id
        )
        for iid in needed_ids
    ):
        raise HTTPException(
            status_code=400,
            detail="Could not find image files on disk for the selected layer. Check dataset paths and URLs.",
        )

    image_dict_b64 = base64.b64encode(json.dumps(image_dict).encode()).decode()
    predictions_b64 = base64.b64encode(json.dumps(predictions_by_field).encode()).decode()

    # Build script: one predictions field per annotation file (inside the image loop)
    field_blocks = []
    for fn in predictions_by_field:
        fn_esc = fn.replace("\\", "\\\\").replace("'", "\\'")
        field_blocks.append(f"    if '{fn_esc}' in predictions_by_field:")
        field_blocks.append(f"        by_img = predictions_by_field['{fn_esc}']")
        field_blocks.append("        if img_id in by_img:")
        field_blocks.append("            detections = []")
        field_blocks.append("            for pred in by_img[img_id]:")
        field_blocks.append("                d = fo.Detection(")
        field_blocks.append("                    label=pred['label'],")
        field_blocks.append("                    bounding_box=pred['bbox'],")
        field_blocks.append("                    confidence=pred['confidence'])")
        field_blocks.append("                detections.append(d)")
        field_blocks.append(f"            sample['{fn_esc}'] = fo.Detections(detections=detections)")

    script_content = f"""
import fiftyone as fo
import json
from pathlib import Path

dataset_name = "annotations_ds_{dataset_id}"
if dataset_name in fo.list_datasets():
    fo.delete_dataset(dataset_name)
dataset = fo.Dataset(dataset_name)
dataset.persistent = False

import base64 as _b64
image_dict = json.loads(_b64.b64decode('''{image_dict_b64}''').decode())
predictions_by_field = json.loads(_b64.b64decode('''{predictions_b64}''').decode())

_projects_root = Path("projects")
if not _projects_root.exists():
    _projects_root = Path("/app/projects")
_data_root = Path("data")

samples = []
for img_id, img_info in image_dict.items():
    img_path = None
    fp = img_info.get('fs_path')
    if fp:
        img_path = Path(fp)
    if not img_path or not img_path.exists():
        img_path = _projects_root / "{eff_project_id}" / "{dataset_id}" / "images" / img_info['file_name']
    if not img_path.exists():
        img_path = _data_root / "images" / "{dataset_id}" / img_info['file_name']
    if not img_path.exists():
        continue
    sample = fo.Sample(filepath=str(img_path))
"""
    script_content += "\n".join(field_blocks)
    script_content += """
    samples.append(sample)

if not samples:
    import sys
    print("ERROR: No image files found on disk for FiftyOne", file=sys.stderr)
    sys.exit(1)

dataset.add_samples(samples)
print(f"Loaded {len(samples)} samples, {len(predictions_by_field)} prediction fields")

import signal, sys
def _h(sig, frame): sys.exit(0)
signal.signal(signal.SIGINT, _h)
signal.signal(signal.SIGTERM, _h)
print('Launching FiftyOne app on port 5151...')
session = fo.launch_app(dataset, port=5151, address="0.0.0.0")
session.wait(-1)
"""

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(script_content)
            script_path = f.name
        process = subprocess.Popen(
            ["python", script_path],
            stdout=open("/tmp/fiftyone_stdout.log", "w"),
            stderr=open("/tmp/fiftyone_stderr.log", "w"),
            env={**os.environ, "FIFTYONE_DEFAULT_APP_PORT": "5151", "FIFTYONE_DEFAULT_APP_ADDRESS": "0.0.0.0"},
            start_new_session=True,
        )
        time.sleep(2)
        if process.poll() is not None:
            try:
                with open("/tmp/fiftyone_stderr.log") as ef:
                    err = ef.read()
                raise HTTPException(status_code=500, detail=f"FiftyOne failed: {err[:500]}")
            except FileNotFoundError:
                raise HTTPException(status_code=500, detail="FiftyOne failed to start")
        return {
            "success": True,
            "data": {
                "message": "FiftyOne is starting. Open http://localhost:5151 to view annotations as predictions.",
                "url": "http://localhost:5151",
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("view_annotations_in_fiftyone")
        raise HTTPException(status_code=500, detail=str(e))
