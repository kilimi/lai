"""Model evaluation and prediction export (service layer)."""
from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.evaluation_artifacts import load_merged_evaluation_results
from app.models import Dataset, Image, ImageCollection, Task
from app.services.annotation_processing import segmentation_to_coco_polygons

logger = logging.getLogger(__name__)

def _slug_for_attachment_filename(
    part: Optional[str], default: str, max_len: int = 72
) -> str:
    """Stable ASCII-ish slug for downloadable filenames (avoid path / header issues)."""
    if not part or not str(part).strip():
        return default
    raw = str(part).strip()
    slug = "".join(
        (c if c.isascii() and (c.isalnum() or c in ("_", "-")) else "_") for c in raw
    )
    slug = slug.strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    slug = slug[:max_len].strip("_")
    return slug or default


def _content_disposition_attachment(filename_safe: str) -> str:
    """Content-Disposition for downloads (sanitize quotes)."""
    safe = filename_safe.replace('"', "'")
    return f'attachment; filename="{safe}"'


def _fiftyone_bbox_normalized_from_xyxy_pixel(
    xyxy_pixel: List[float], img_width: float, img_height: float
) -> List[float]:
    """FiftyOne Detection.bounding_box expects normalized [x, y, w, h] in [0, 1]."""
    w = float(img_width) or 1.0
    h = float(img_height) or 1.0
    x1, y1, x2, y2 = (float(v) for v in xyxy_pixel[:4])
    return [x1 / w, y1 / h, max(0.0, x2 - x1) / w, max(0.0, y2 - y1) / h]


def _match_training_class_name(class_names: List[str], category: Optional[str]) -> Optional[str]:
    if not category:
        return None
    cat_lower = category.lower()
    for cn in class_names:
        if cn == "background":
            continue
        if cn.lower() == cat_lower:
            return cn
    return category


def _build_fiftyone_ground_truth_by_image(
    *,
    results: Dict[str, Any],
    images_by_id: Dict[int, Image],
    annotation_file_id: Optional[str],
    class_names: List[str],
    db: Session,
) -> Dict[int, List[dict]]:
    """
    Ground truth for FiftyOne as fo.Detections (normalized xywh).

    Prefer evaluation artifact ``all_ground_truth`` (xyxy pixels, same as metrics).
    Fall back to DB annotations with correct coordinate handling (bbox_* fields are
    already normalized; do not divide by image size again).
    """
    ground_truth_by_image: Dict[int, List[dict]] = {}

    all_gt = results.get("all_ground_truth") or []
    if all_gt:
        for gt in all_gt:
            try:
                img_id = int(gt["image_id"])
            except (TypeError, ValueError):
                continue
            img = images_by_id.get(img_id)
            if not img:
                continue
            bbox_xyxy = gt.get("bbox")
            if not isinstance(bbox_xyxy, list) or len(bbox_xyxy) < 4:
                continue
            label = gt.get("class_name")
            if not label:
                cid = int(gt.get("class_id", -1))
                if 0 <= cid < len(class_names):
                    label = class_names[cid]
                else:
                    label = "unknown"
            w, h = float(img.width or 1), float(img.height or 1)
            ground_truth_by_image.setdefault(img_id, []).append(
                {
                    "label": label,
                    "bbox": _fiftyone_bbox_normalized_from_xyxy_pixel(bbox_xyxy, w, h),
                    "confidence": 1.0,
                }
            )
        return ground_truth_by_image

    if not annotation_file_id:
        return ground_truth_by_image

    from sqlalchemy.orm import joinedload

    from app.models import Annotation, AnnotationFile

    annotation_file = (
        db.query(AnnotationFile).filter(AnnotationFile.id == annotation_file_id).first()
    )
    if not annotation_file:
        return ground_truth_by_image

    annotations = (
        db.query(Annotation)
        .options(joinedload(Annotation.image))
        .filter(Annotation.annotation_file_id == annotation_file_id)
        .all()
    )

    for ann in annotations:
        img = images_by_id.get(ann.image_id) or ann.image
        if not img:
            continue
        w = float(img.width or 1) or 1.0
        h = float(img.height or 1) or 1.0

        bbox_norm: Optional[List[float]] = None
        from app.services.dataset_fiftyone_service import _fiftyone_bbox_norm_from_annotation

        bbox_norm = _fiftyone_bbox_norm_from_annotation(ann, w, h)

        if bbox_norm is None:
            continue

        label = _match_training_class_name(class_names, ann.category) or ann.category or "unknown"
        ground_truth_by_image.setdefault(ann.image_id, []).append(
            {"label": label, "bbox": bbox_norm, "confidence": 1.0}
        )

    return ground_truth_by_image


def _xywh_to_xyxy(bbox: List[float]) -> List[float]:
    if len(bbox) < 4:
        return [0.0, 0.0, 0.0, 0.0]
    x, y, w, h = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    return [x, y, x + w, y + h]


def _xyxy_to_xywh(bbox: List[float]) -> List[float]:
    if len(bbox) < 4:
        return [0.0, 0.0, 0.0, 0.0]
    x1, y1, x2, y2 = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
    return [x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1)]


def _iou_xyxy(a: List[float], b: List[float]) -> float:
    if len(a) < 4 or len(b) < 4:
        return 0.0
    x1 = max(float(a[0]), float(b[0]))
    y1 = max(float(a[1]), float(b[1]))
    x2 = min(float(a[2]), float(b[2]))
    y2 = min(float(a[3]), float(b[3]))
    iw = max(0.0, x2 - x1)
    ih = max(0.0, y2 - y1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    aa = max(0.0, float(a[2]) - float(a[0])) * max(0.0, float(a[3]) - float(a[1]))
    ba = max(0.0, float(b[2]) - float(b[0])) * max(0.0, float(b[3]) - float(b[1]))
    union = aa + ba - inter
    if union <= 0:
        return 0.0
    return inter / union


def _prediction_xyxy(pred: Dict[str, Any]) -> Optional[List[float]]:
    bbox_xyxy = pred.get("bbox_xyxy")
    if isinstance(bbox_xyxy, list) and len(bbox_xyxy) >= 4:
        return [float(bbox_xyxy[0]), float(bbox_xyxy[1]), float(bbox_xyxy[2]), float(bbox_xyxy[3])]
    bbox = pred.get("bbox")
    if isinstance(bbox, list) and len(bbox) >= 4:
        return _xywh_to_xyxy(bbox)
    return None


def _filter_true_positive_predictions(
    predictions: List[Dict[str, Any]],
    all_ground_truth: List[Dict[str, Any]],
    iou_threshold: float,
    selected_class_ids: Optional[List[int]],
) -> List[Dict[str, Any]]:
    selected = set(int(c) for c in (selected_class_ids or [])) if selected_class_ids else None

    gt_by_image: Dict[int, List[Dict[str, Any]]] = {}
    for gt in all_ground_truth or []:
        try:
            image_id = int(gt.get("image_id"))
            class_id = int(gt.get("class_id"))
            bbox = gt.get("bbox")
        except Exception:
            continue
        if class_id < 0:
            continue
        if selected is not None and class_id not in selected:
            continue
        if not isinstance(bbox, list) or len(bbox) < 4:
            continue
        gt_by_image.setdefault(image_id, []).append({
            "class_id": class_id,
            "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
        })

    preds_by_image: Dict[int, List[Dict[str, Any]]] = {}
    for pred in predictions:
        try:
            image_id = int(pred.get("image_id"))
            class_id = int(pred.get("class_id"))
        except Exception:
            continue
        if selected is not None and class_id not in selected:
            continue
        xyxy = _prediction_xyxy(pred)
        if xyxy is None:
            continue
        pred_copy = dict(pred)
        pred_copy["bbox_xyxy"] = xyxy
        preds_by_image.setdefault(image_id, []).append(pred_copy)

    kept: List[Dict[str, Any]] = []
    for image_id, preds in preds_by_image.items():
        gts = gt_by_image.get(image_id, [])
        if not gts:
            continue

        matched_gt: set[int] = set()
        preds_sorted = sorted(preds, key=lambda p: float(p.get("conf", 0.0)), reverse=True)

        for pred in preds_sorted:
            pred_class = int(pred.get("class_id", -1))
            pred_bbox = pred.get("bbox_xyxy")
            if pred_class < 0 or not isinstance(pred_bbox, list) or len(pred_bbox) < 4:
                continue

            best_iou = 0.0
            best_gt_idx = -1
            for gi, gt in enumerate(gts):
                if gi in matched_gt:
                    continue
                if int(gt.get("class_id", -1)) != pred_class:
                    continue
                iou_val = _iou_xyxy(pred_bbox, gt.get("bbox", []))
                if iou_val > best_iou:
                    best_iou = iou_val
                    best_gt_idx = gi

            if best_gt_idx >= 0 and best_iou >= float(iou_threshold):
                matched_gt.add(best_gt_idx)
                kept.append(pred)

    return kept


def _filter_predictions_by_cm_cells(
    predictions: List[Dict[str, Any]],
    all_ground_truth: Optional[List[Dict[str, Any]]],
    iou_threshold: float,
    selected_cells: List[List[int]],
    num_real_classes: int,
) -> List[Dict[str, Any]]:
    """
    Keep predictions whose (gt_class, pred_class) cell matches a selected confusion-matrix cell.
    gt_class == num_real_classes represents the background row (i.e. false positives — no GT match).
    Cells where pred_class == num_real_classes (FN column) cannot be saved (no prediction exists).
    """
    if not selected_cells:
        return []

    cells: set[tuple[int, int]] = set()
    for cell in selected_cells:
        if not isinstance(cell, (list, tuple)) or len(cell) < 2:
            continue
        try:
            r = int(cell[0])
            c = int(cell[1])
        except Exception:
            continue
        if c == num_real_classes:
            # FN column — no prediction to save
            continue
        cells.add((r, c))

    if not cells:
        return []

    # If no ground truth is available, degrade gracefully:
    # keep predictions by selected prediction columns only.
    if not all_ground_truth:
        selected_pred_classes = {
            c for _, c in cells if 0 <= c < num_real_classes
        }
        if not selected_pred_classes:
            return []
        kept_no_gt: List[Dict[str, Any]] = []
        for pred in predictions:
            try:
                pred_class = int(pred.get("class_id", -1))
            except Exception:
                continue
            if pred_class in selected_pred_classes:
                kept_no_gt.append(pred)
        return kept_no_gt

    gt_by_image: Dict[int, List[Dict[str, Any]]] = {}
    for gt in all_ground_truth or []:
        try:
            image_id = int(gt.get("image_id"))
            class_id = int(gt.get("class_id"))
            bbox = gt.get("bbox")
        except Exception:
            continue
        if class_id < 0 or class_id >= num_real_classes:
            continue
        if not isinstance(bbox, list) or len(bbox) < 4:
            continue
        gt_by_image.setdefault(image_id, []).append({
            "class_id": class_id,
            "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
        })

    preds_by_image: Dict[int, List[Dict[str, Any]]] = {}
    for pred in predictions:
        try:
            image_id = int(pred.get("image_id"))
        except Exception:
            continue
        xyxy = _prediction_xyxy(pred)
        if xyxy is None:
            continue
        p = dict(pred)
        p["bbox_xyxy"] = xyxy
        preds_by_image.setdefault(image_id, []).append(p)

    kept: List[Dict[str, Any]] = []
    for image_id, preds in preds_by_image.items():
        gts = gt_by_image.get(image_id, [])
        matched_gt: set[int] = set()
        preds_sorted = sorted(preds, key=lambda p: float(p.get("conf", 0.0)), reverse=True)

        for pred in preds_sorted:
            try:
                pred_class = int(pred.get("class_id", -1))
            except Exception:
                continue
            if pred_class < 0 or pred_class >= num_real_classes:
                continue
            pred_bbox = pred.get("bbox_xyxy")

            best_iou = 0.0
            best_gt_idx = -1
            for gi, gt in enumerate(gts):
                if gi in matched_gt:
                    continue
                iou_val = _iou_xyxy(pred_bbox, gt.get("bbox", []))
                if iou_val > best_iou:
                    best_iou = iou_val
                    best_gt_idx = gi

            if best_gt_idx >= 0 and best_iou >= float(iou_threshold):
                matched_gt.add(best_gt_idx)
                gt_class = int(gts[best_gt_idx]["class_id"])
                if (gt_class, pred_class) in cells:
                    kept.append(pred)
            else:
                # background row FP
                if (num_real_classes, pred_class) in cells:
                    kept.append(pred)

    return kept


def build_thresholded_evaluation_coco_bundle(
    db: Session,
    task: Task,
    task_id: int,
    conf_threshold: Optional[float],
    iou_threshold: Optional[float],
    per_class_conf_dict: Optional[Dict[str, Any]],
    save_selection: Literal["all", "tp_per_class", "cm_cells"] = "all",
    selected_class_ids: Optional[List[int]] = None,
    selected_cells: Optional[List[List[int]]] = None,
) -> tuple[Dict[str, Any], str, int, Optional[int]]:
    """
    Build COCO dict from a completed model_evaluation task (confidence-filtered; same rules as export-coco).
    Returns (coco_output, download_filename, dataset_id, collection_id).
    """
    if task.task_type != "model_evaluation":
        raise HTTPException(status_code=400, detail="Task is not an evaluation task")
    if task.status != "completed":
        raise HTTPException(status_code=400, detail="Evaluation not completed")

    results = load_merged_evaluation_results((task.task_metadata or {}).get("results", {}))
    if not results:
        raise HTTPException(status_code=404, detail="No evaluation results found")

    predictions = results.get("predictions", [])
    dataset_id = results.get("dataset_id")
    collection_id = results.get("collection_id")
    class_names = results.get("class_names", [])
    checkpoint = results.get("checkpoint", "best")
    task_meta = task.task_metadata or {}

    # Keep save/export behavior consistent with evaluation settings:
    # classes ignored in evaluation metrics should not be persisted as predictions.
    ignored_classes = task_meta.get("ignored_classes") or []
    ignored_class_ids: set[int] = set()
    if ignored_classes:
        class_name_to_id = {
            str(name).strip().lower(): idx
            for idx, name in enumerate(class_names)
            if name is not None
        }
        ignored_class_ids = {
            class_name_to_id[str(name).strip().lower()]
            for name in ignored_classes
            if isinstance(name, str) and str(name).strip().lower() in class_name_to_id
        }

    # Also exclude synthetic/non-usable labels from persisted output.
    non_savable_class_ids: set[int] = set()
    for idx, class_name in enumerate(class_names):
        normalized = (str(class_name).strip().lower() if class_name is not None else "")
        if not normalized or normalized in {"background", "bg", "empty", "__background__", "background_empty"}:
            non_savable_class_ids.add(idx)

    excluded_class_ids = ignored_class_ids | non_savable_class_ids

    if dataset_id is None:
        raise HTTPException(status_code=400, detail="Evaluation results are missing dataset_id")

    conf_threshold_value = (
        conf_threshold if conf_threshold is not None else results.get("conf_threshold", 0.25)
    )
    iou_threshold_value = (
        iou_threshold if iou_threshold is not None else results.get("iou_threshold", 0.45)
    )

    effective_per_class = per_class_conf_dict if per_class_conf_dict else results.get("per_class_conf", None)

    if not predictions:
        raise HTTPException(status_code=404, detail="No predictions found in evaluation results")

    logger.info(
        "Filtering predictions for COCO bundle task_id=%s conf=%s iou=%s per_class=%s",
        task_id,
        conf_threshold_value,
        iou_threshold_value,
        effective_per_class,
    )
    filtered_predictions = []
    for pred in predictions:
        pred_conf = pred.get("conf", 0)
        try:
            pred_class_id = int(pred.get("class_id", 0))
        except Exception:
            continue
        if pred_class_id in excluded_class_ids:
            continue
        if effective_per_class and pred_class_id < len(class_names):
            class_name = class_names[pred_class_id]
            threshold = effective_per_class.get(class_name, conf_threshold_value)
        else:
            threshold = conf_threshold_value
        if pred_conf >= threshold:
            filtered_predictions.append(pred)

    predictions = filtered_predictions

    if save_selection == "tp_per_class":
        all_ground_truth = results.get("all_ground_truth", [])
        if not all_ground_truth:
            raise HTTPException(
                status_code=400,
                detail="Ground truth is required to save TP-per-class predictions.",
            )
        predictions = _filter_true_positive_predictions(
            predictions,
            all_ground_truth,
            float(iou_threshold_value),
            selected_class_ids,
        )
    elif save_selection == "cm_cells":
        all_ground_truth = results.get("all_ground_truth", [])
        num_real_classes = max(0, len(class_names) - 1)
        predictions = _filter_predictions_by_cm_cells(
            predictions,
            all_ground_truth,
            float(iou_threshold_value),
            selected_cells or [],
            num_real_classes,
        )

    if not predictions:
        if save_selection == "tp_per_class":
            raise HTTPException(
                status_code=404,
                detail="No true-positive predictions match the selected classes at current thresholds.",
            )
        if save_selection == "cm_cells":
            raise HTTPException(
                status_code=404,
                detail="No predictions fall into the selected confusion-matrix cells at current thresholds.",
            )
        raise HTTPException(status_code=404, detail="No predictions pass the confidence threshold")

    has_masks = any(pred.get("segmentation") and len(pred.get("segmentation", [])) > 0 for pred in predictions)

    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
    if collection_id is not None:
        images_query = images_query.filter(Image.collection_id == collection_id)
    images = images_query.all()
    if not images:
        raise HTTPException(status_code=400, detail="No images found in dataset")

    task_type = "segmentation" if has_masks else "detection"
    coco_output: Dict[str, Any] = {
        "info": {
            "description": f"Evaluation results for task {task_id} (thresholded export)",
            "date_created": datetime.now(timezone.utc).isoformat(),
            "task_name": task.name,
            "model_checkpoint": checkpoint,
            "task_type": task_type,
            "conf_threshold": conf_threshold_value,
            "iou_threshold": iou_threshold_value,
            "per_class_conf": effective_per_class if effective_per_class else None,
                "ignored_classes": ignored_classes if ignored_classes else None,
                "excluded_class_ids": sorted(excluded_class_ids) if excluded_class_ids else None,
                "save_selection": save_selection,
                "selected_class_ids": selected_class_ids if selected_class_ids else None,
                "selected_cells": selected_cells if selected_cells else None,
        },
        "images": [],
        "annotations": [],
        "categories": [],
    }

    saved_class_ids = {
        int(pred["class_id"])
        for pred in predictions
        if pred.get("class_id") is not None
    }

    for idx, class_name in enumerate(class_names):
        if idx in excluded_class_ids:
            continue
        if save_selection != "all" and idx not in saved_class_ids:
            continue
        coco_output["categories"].append(
            {"id": idx, "name": class_name, "supercategory": "object"}
        )

    for img in images:
        coco_output["images"].append(
            {
                "id": img.id,
                "file_name": img.file_name,
                "width": img.width or 0,
                "height": img.height or 0,
                "date_captured": img.uploaded_at.isoformat() if img.uploaded_at else None,
            }
        )

    for idx, pred in enumerate(predictions, start=1):
        bbox_xywh = pred.get("bbox")
        if not (isinstance(bbox_xywh, list) and len(bbox_xywh) >= 4):
            bbox_xyxy = _prediction_xyxy(pred)
            bbox_xywh = _xyxy_to_xywh(bbox_xyxy or [0.0, 0.0, 0.0, 0.0])
        segmentation = segmentation_to_coco_polygons(pred.get("segmentation"))
        coco_output["annotations"].append(
            {
                "id": idx,
                "image_id": pred["image_id"],
                "category_id": pred["class_id"],
                "bbox": bbox_xywh,
                "score": pred["conf"],
                "segmentation": segmentation,
            }
        )

    meta = task.task_metadata or {}
    ds_label = dataset.name or meta.get("dataset_name") or ""
    eval_slug = _slug_for_attachment_filename(task.name, f"evaluation_{task_id}")
    ds_slug = _slug_for_attachment_filename(
        str(ds_label) if ds_label else None, f"dataset_{dataset_id}"
    )
    filename = f"{eval_slug}_{task_id}_{ds_slug}_coco.json"

    return coco_output, filename, int(dataset_id), collection_id


def _resolve_eval_image_path(
    img: Image, project_id: Optional[int], dataset_id: int
) -> Optional[Path]:
    """Resolve image path for evaluation/snapshot serving (shared logic with Celery evaluation)."""
    file_name = (getattr(img, "file_name", None) or "").strip()
    if not file_name:
        logger.warning(
            "Cannot resolve eval image path: image id=%s has empty file_name",
            getattr(img, "id", None),
        )
        return None

    resolved = resolve_dataset_image_path_from_models(
        img,
        dataset_id=int(dataset_id),
        project_id=project_id,
    )
    if resolved is None:
        logger.info(
            "Eval image not resolved on disk: image_id=%s dataset_id=%s project_id=%s file_name=%s url=%s",
            getattr(img, "id", None),
            dataset_id,
            project_id,
            file_name,
            (getattr(img, "url", None) or "").strip(),
        )
    return resolved


class DatasetEvalConfig(BaseModel):
    """Configuration for a single dataset in multi-dataset evaluation"""
    datasetId: int
    datasetName: str
    annotationFileId: Optional[str] = None
    annotationFileName: Optional[str] = None
    collectionId: Optional[int] = None


class EvaluationRequest(BaseModel):
    """Request model for model evaluation"""
    task_id: int  # Training task ID
    dataset_id: int
    collection_id: Optional[int] = None
    annotation_file_id: Optional[str] = None  # Ground truth annotations
    checkpoint: str = "best"  # "best" or "last"
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    nms_iou_threshold: float = 0.45  # IoU threshold for Non-Maximum Suppression
    evaluation_name: Optional[str] = None  # Custom name for evaluation
    # Grid inference settings
    use_grid: bool = False  # Enable grid-based inference
    grid_size: int = 640  # Size of each grid tile
    grid_overlap: float = 0.2  # Overlap ratio (0.0 to 0.5)
    # Ignored classes for metric calculation
    ignored_classes: Optional[List[str]] = None  # List of class names to ignore in metrics
    image_size: Optional[int] = None  # Inference image size (defaults to trained model size)


class MultiDatasetEvaluationRequest(BaseModel):
    """Request model for multi-dataset evaluation"""
    task_id: int  # Training task ID
    datasets: List[DatasetEvalConfig]  # List of datasets to evaluate
    checkpoint: str = "best"  # "best" or "last"
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    nms_iou_threshold: float = 0.45  # IoU threshold for Non-Maximum Suppression
    evaluation_name: Optional[str] = None  # Custom name for evaluation
    # Grid inference settings
    use_grid: bool = False  # Enable grid-based inference
    grid_size: int = 640  # Size of each grid tile
    grid_overlap: float = 0.2  # Overlap ratio (0.0 to 0.5)
    # Ignored classes for metric calculation
    ignored_classes: Optional[List[str]] = None  # List of class names to ignore in metrics
    image_size: Optional[int] = None  # Inference image size (defaults to trained model size)


async def evaluate_model(
    request: EvaluationRequest,
    db: Session = Depends(get_db)
):
    """
    Start model evaluation as a background task
    """
    try:
        # Validate training task exists
        training_task = db.query(Task).filter(Task.id == request.task_id).first()
        if not training_task or training_task.status != 'completed':
            raise HTTPException(status_code=404, detail="Training task not found or not completed")
        
        # Validate dataset exists
        dataset = db.query(Dataset).filter(Dataset.id == request.dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        selected_collection_name = None
        if request.collection_id is not None:
            selected_collection = db.query(ImageCollection).filter(
                ImageCollection.id == request.collection_id,
                ImageCollection.dataset_id == request.dataset_id,
            ).first()
            if not selected_collection:
                raise HTTPException(status_code=400, detail="Selected image collection does not belong to the dataset")
            selected_collection_name = selected_collection.name
        
        # Get model info from training task
        task_metadata = training_task.task_metadata or {}
        model_type = task_metadata.get('model_type', 'Unknown')
        from app.ml.dispatch import framework_label_for_task

        framework = framework_label_for_task(training_task)
        is_mmyolo = framework == "mmyolo"
        
        # Use custom name if provided, otherwise generate default name
        eval_name = request.evaluation_name.strip() if request.evaluation_name else f"Evaluation - {training_task.name} on {dataset.name}"
        
        # Get annotation file name if provided
        annotation_file_name = None
        if request.annotation_file_id:
            from app.models import AnnotationFile
            annotation_file = db.query(AnnotationFile).filter(AnnotationFile.id == request.annotation_file_id).first()
            if annotation_file:
                annotation_file_name = annotation_file.name
        
        # Create evaluation task in database
        eval_task = Task(
            name=eval_name,
            task_type="model_evaluation",
            status="pending",
            project_id=dataset.project_id,
            progress=0,
            task_metadata={
                "training_task_id": request.task_id,
                "training_task_name": training_task.name,
                "dataset_id": request.dataset_id,
                "dataset_name": dataset.name,
                "collection_id": request.collection_id,
                "collection_name": selected_collection_name,
                "annotation_file_id": request.annotation_file_id,
                "annotation_file_name": annotation_file_name,
                "checkpoint": request.checkpoint,
                "image_size": request.image_size,
                "conf_threshold": request.conf_threshold,
                "iou_threshold": request.iou_threshold,
                "model_type": model_type,
                "framework": framework,
                "has_ground_truth": request.annotation_file_id is not None,
                "use_grid": request.use_grid,
                "grid_size": request.grid_size,
                "grid_overlap": request.grid_overlap,
                "ignored_classes": request.ignored_classes or []
            }
        )
        db.add(eval_task)
        db.commit()
        db.refresh(eval_task)
        
        # Import and start Celery task
        from app.tasks.evaluation_tasks import evaluate_model as evaluate_model_task
        
        celery_task = evaluate_model_task.delay(
            eval_task.id,
            request.task_id,
            request.dataset_id,
            request.annotation_file_id,
            request.checkpoint,
            request.conf_threshold,
            request.iou_threshold,
            request.nms_iou_threshold,
            request.use_grid,
            request.grid_size,
            request.grid_overlap,
            request.collection_id,
            request.ignored_classes or [],
            request.image_size,
        )
        
        # Update task with Celery ID
        eval_task.task_metadata = {
            **eval_task.task_metadata,
            'celery_task_id': celery_task.id
        }
        db.commit()
        
        logger.info(f"Started evaluation task {eval_task.id} with Celery task {celery_task.id}")
        
        return {
            "success": True,
            "message": "Evaluation started",
            "task_id": eval_task.id,
            "task_name": eval_task.name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting evaluation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start evaluation: {str(e)}")


async def evaluate_model_multiple_datasets(
    request: MultiDatasetEvaluationRequest,
    db: Session = Depends(get_db)
):
    """
    Start model evaluation on multiple datasets as a parent task with child tasks
    """
    try:
        # Validate training task exists
        training_task = db.query(Task).filter(Task.id == request.task_id).first()
        if not training_task or training_task.status != 'completed':
            raise HTTPException(status_code=404, detail="Training task not found or not completed")
        
        if not request.datasets or len(request.datasets) == 0:
            raise HTTPException(status_code=400, detail="At least one dataset is required")
        
        # Get model info from training task
        task_metadata = training_task.task_metadata or {}
        model_type = task_metadata.get('model_type', 'Unknown')
        from app.ml.dispatch import framework_label_for_task

        framework = framework_label_for_task(training_task)
        is_mmyolo = framework == "mmyolo"
        
        # Get project_id from first dataset
        first_dataset = db.query(Dataset).filter(Dataset.id == request.datasets[0].datasetId).first()
        if not first_dataset:
            raise HTTPException(status_code=404, detail="First dataset not found")
        
        project_id = first_dataset.project_id
        
        # Use custom name if provided, otherwise generate default name
        dataset_names = [d.datasetName for d in request.datasets]
        eval_name = request.evaluation_name.strip() if request.evaluation_name else f"Multi-Dataset Eval - {training_task.name}"
        
        # Create parent evaluation task
        parent_task = Task(
            name=eval_name,
            task_type="model_evaluation",
            status="pending",
            project_id=project_id,
            progress=0,
            task_metadata={
                "training_task_id": request.task_id,
                "training_task_name": training_task.name,
                "is_multi_dataset": True,
                "dataset_count": len(request.datasets),
                "dataset_names": dataset_names,
                "checkpoint": request.checkpoint,
                "image_size": request.image_size,
                "conf_threshold": request.conf_threshold,
                "iou_threshold": request.iou_threshold,
                "model_type": model_type,
                "framework": framework,
                "use_grid": request.use_grid,
                "grid_size": request.grid_size,
                "grid_overlap": request.grid_overlap,
                "ignored_classes": request.ignored_classes or [],
                "child_task_ids": []  # Will be populated with child task IDs
            }
        )
        db.add(parent_task)
        db.commit()
        db.refresh(parent_task)
        
        # Create child tasks for each dataset
        child_task_ids = []
        from app.tasks.evaluation_tasks import evaluate_model as evaluate_model_task
        
        logger.info(f"Processing {len(request.datasets)} datasets for multi-dataset evaluation")
        for idx, dataset_config in enumerate(request.datasets):
            logger.info(f"Processing dataset {idx+1}/{len(request.datasets)}: ID={dataset_config.datasetId}, Name={dataset_config.datasetName}")
            
            # Validate dataset exists
            dataset = db.query(Dataset).filter(Dataset.id == dataset_config.datasetId).first()
            if not dataset:
                logger.warning(f"Dataset {dataset_config.datasetId} not found, skipping")
                continue

            selected_collection_name = None
            if dataset_config.collectionId is not None:
                selected_collection = db.query(ImageCollection).filter(
                    ImageCollection.id == dataset_config.collectionId,
                    ImageCollection.dataset_id == dataset_config.datasetId,
                ).first()
                if not selected_collection:
                    logger.warning(
                        f"Collection {dataset_config.collectionId} does not belong to dataset {dataset_config.datasetId}, skipping"
                    )
                    continue
                selected_collection_name = selected_collection.name
            
            # Get annotation file name if provided
            annotation_file_name = dataset_config.annotationFileName
            
            # Create child evaluation task
            child_name = f"{eval_name} - {dataset_config.datasetName}"
            child_task = Task(
                name=child_name,
                task_type="model_evaluation",
                status="pending",
                project_id=project_id,
                progress=0,
                task_metadata={
                    "training_task_id": request.task_id,
                    "training_task_name": training_task.name,
                    "dataset_id": dataset_config.datasetId,
                    "dataset_name": dataset_config.datasetName,
                    "collection_id": dataset_config.collectionId,
                    "collection_name": selected_collection_name,
                    "annotation_file_id": dataset_config.annotationFileId,
                    "annotation_file_name": annotation_file_name,
                    "checkpoint": request.checkpoint,
                    "image_size": request.image_size,
                    "conf_threshold": request.conf_threshold,
                    "iou_threshold": request.iou_threshold,
                    "model_type": model_type,
                    "has_ground_truth": dataset_config.annotationFileId is not None,
                    "use_grid": request.use_grid,
                    "grid_size": request.grid_size,
                    "grid_overlap": request.grid_overlap,
                    "ignored_classes": request.ignored_classes or [],
                    "parent_task_id": parent_task.id,
                    "dataset_index": idx
                }
            )
            db.add(child_task)
            db.commit()
            db.refresh(child_task)
            
            # Start Celery task for this dataset
            celery_task = evaluate_model_task.delay(
                child_task.id,
                request.task_id,
                dataset_config.datasetId,
                dataset_config.annotationFileId,
                request.checkpoint,
                request.conf_threshold,
                request.iou_threshold,
                request.nms_iou_threshold,
                request.use_grid,
                request.grid_size,
                request.grid_overlap,
                dataset_config.collectionId,
                request.ignored_classes or [],
                request.image_size,
            )
            
            # Update child task with Celery ID
            child_task.task_metadata = {
                **child_task.task_metadata,
                'celery_task_id': celery_task.id
            }
            db.commit()
            
            child_task_ids.append(child_task.id)
            logger.info(f"Started child evaluation task {child_task.id} for dataset {dataset_config.datasetName}")
        
        # Update parent task with child task IDs
        parent_task.status = "running"
        parent_task.task_metadata = {
            **parent_task.task_metadata,
            "child_task_ids": child_task_ids
        }
        db.commit()
        
        logger.info(f"Started multi-dataset evaluation with parent task {parent_task.id} and {len(child_task_ids)} child tasks")
        
        return {
            "success": True,
            "message": f"Multi-dataset evaluation started with {len(child_task_ids)} datasets",
            "task_id": parent_task.id,
            "task_name": parent_task.name,
            "child_task_ids": child_task_ids
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting multi-dataset evaluation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start evaluation: {str(e)}")


async def get_evaluation_blobs(
    task_id: int,
    db: Session = Depends(get_db)
):
    """
    Large per-detection payload (predictions, ground-truth flat list, CM drill-down samples).
    Stored on disk for new evaluations; legacy tasks may serve from inline task_metadata.
    """
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.task_type != 'model_evaluation':
        raise HTTPException(status_code=400, detail="Task is not an evaluation task")
    if task.status != 'completed':
        raise HTTPException(status_code=400, detail="Evaluation not completed")
    results = (task.task_metadata or {}).get('results', {})
    merged = load_merged_evaluation_results(results)
    return {
        "predictions": merged.get("predictions", []),
        "all_ground_truth": merged.get("all_ground_truth", []),
        "confusion_matrix_samples": merged.get("confusion_matrix_samples", {}),
    }


async def get_evaluation_image(
    task_id: int,
    image_id: int,
    db: Session = Depends(get_db),
):
    """Serve raw image file for evaluation snapshot cards."""
    try:
        task = db.query(Task).filter(Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if task.task_type != 'model_evaluation':
            raise HTTPException(status_code=400, detail="Task is not an evaluation task")

        # The image must exist, but the dataset may be discovered from either
        # the task's results or by following the image -> dataset relation
        # (parent multi-dataset tasks have no top-level results).
        img = db.query(Image).filter(Image.id == image_id).first()
        if not img:
            raise HTTPException(status_code=404, detail="Image not found")

        dataset_id = img.dataset_id
        # Cross-check against the task's recorded dataset when possible.
        metadata = task.task_metadata or {}
        results = load_merged_evaluation_results(metadata.get('results') or {})
        recorded_dataset_id = results.get('dataset_id') if results else None
        if recorded_dataset_id and dataset_id and recorded_dataset_id != dataset_id:
            # If the task's recorded dataset doesn't match, the image is foreign.
            # Allow it through anyway as long as a child task references it; we
            # only need to serve the file from disk.
            logger.debug(
                "Image %s belongs to dataset %s but task %s recorded dataset %s",
                image_id,
                dataset_id,
                task_id,
                recorded_dataset_id,
            )

        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first() if dataset_id else None

        project_id: Optional[int] = None
        if dataset is not None and getattr(dataset, "project_id", None):
            project_id = int(dataset.project_id)
        elif getattr(task, "project_id", None):
            project_id = int(task.project_id)

        img_path = _resolve_eval_image_path(img, project_id, dataset_id or 0)
        if img_path is None:
            raise HTTPException(status_code=404, detail="Image file not found on disk")

        suffix = img_path.suffix.lower()
        media_type_map = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
            ".tif": "image/tiff",
            ".tiff": "image/tiff",
        }
        media_type = media_type_map.get(suffix, "application/octet-stream")

        return FileResponse(
            path=str(img_path),
            media_type=media_type,
            filename=img_path.name,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed evaluation-image response for task_id=%s image_id=%s: %s",
            task_id,
            image_id,
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=f"Failed to serve evaluation image: {e}")


async def export_coco_results(
    task_id: int,
    conf_threshold: Optional[float] = None,
    iou_threshold: Optional[float] = None,
    per_class_conf: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Export evaluation results in COCO format"""
    try:
        task = db.query(Task).filter(Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        per_class_conf_dict: Optional[Dict[str, Any]] = None
        if per_class_conf:
            try:
                per_class_conf_dict = json.loads(per_class_conf)
            except json.JSONDecodeError:
                logger.warning("Failed to parse per_class_conf parameter: %s", per_class_conf)

        coco_output, filename, _, _ = build_thresholded_evaluation_coco_bundle(
            db, task, task_id, conf_threshold, iou_threshold, per_class_conf_dict
        )

        return JSONResponse(
            content=coco_output,
            headers={"Content-Disposition": _content_disposition_attachment(filename)},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error exporting COCO results: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to export results: {str(e)}")


class SaveEvalPredictionsToDatasetBody(BaseModel):
    """Save thresholded evaluation predictions as a new COCO annotation file on the dataset."""

    conf_threshold: Optional[float] = None
    iou_threshold: Optional[float] = None
    per_class_conf: Optional[Dict[str, float]] = None
    annotation_name: Optional[str] = None
    active_collection_id: Optional[int] = None
    save_selection: Literal["all", "tp_per_class", "cm_cells"] = "all"
    selected_class_ids: Optional[List[int]] = None
    selected_cells: Optional[List[List[int]]] = None


async def save_evaluation_predictions_to_dataset(
    task_id: int,
    body: SaveEvalPredictionsToDatasetBody,
    db: Session = Depends(get_db),
):
    """
    Create a new annotation file on the evaluation dataset from predictions that pass
    the same confidence filters as Threshold Explorer / export-coco (IoU is for metrics only).
    """
    from app.services.annotation_processing import save_annotations_direct

    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    try:
        coco_output, _, dataset_id, eval_collection_id = build_thresholded_evaluation_coco_bundle(
            db,
            task,
            task_id,
            body.conf_threshold,
            body.iou_threshold,
            body.per_class_conf,
            body.save_selection,
            body.selected_class_ids,
            body.selected_cells,
        )
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=400,
                detail=e.detail or "Nothing to save — adjust confidence or check evaluation data.",
            ) from e
        raise

    if not coco_output.get("annotations"):
        raise HTTPException(status_code=400, detail="No annotations to save after filtering.")

    raw_name = (body.annotation_name or "").strip()
    if raw_name:
        base = _slug_for_attachment_filename(raw_name, f"eval_predictions_{task_id}")
        name = base if base.lower().endswith(".json") else f"{base}.json"
    else:
        slug = _slug_for_attachment_filename(task.name, f"eval_{task_id}")
        name = f"{slug}_predictions.json"

    coll = body.active_collection_id if body.active_collection_id is not None else eval_collection_id

    payload: Dict[str, Any] = {
        "name": name,
        "categories": coco_output["categories"],
        "images": coco_output["images"],
        "annotations": coco_output["annotations"],
        "active_collection_id": coll,
    }

    return await save_annotations_direct(dataset_id, payload, db)


async def save_evaluation_predictions_to_dataset_legacy(
    task_id: int,
    body: SaveEvalPredictionsToDatasetBody,
    db: Session = Depends(get_db),
):
    """
    Backward-compatible alias for older frontend builds.
    """
    return await save_evaluation_predictions_to_dataset(task_id, body, db)


async def export_all_coco_results(
    task_id: int,
    db: Session = Depends(get_db)
):
    """Export all COCO results for a multi-dataset evaluation as a ZIP file"""
    try:
        # Get evaluation task
        task = db.query(Task).filter(Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        
        if task.task_type != 'model_evaluation':
            raise HTTPException(status_code=400, detail="Task is not an evaluation task")
        
        metadata = task.task_metadata or {}
        
        # Check if this is a multi-dataset evaluation
        if not metadata.get('is_multi_dataset'):
            # For single dataset, redirect to single export
            raise HTTPException(status_code=400, detail="This is not a multi-dataset evaluation. Use the single export endpoint.")
        
        child_task_ids = metadata.get('child_task_ids', [])
        if not child_task_ids:
            raise HTTPException(status_code=404, detail="No child tasks found")

        eval_slug_zip = _slug_for_attachment_filename(task.name, f"evaluation_{task_id}")

        # Create a ZIP file in memory
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for child_id in child_task_ids:
                child_task = db.query(Task).filter(Task.id == child_id).first()
                if not child_task or child_task.status != 'completed':
                    continue
                
                child_metadata = child_task.task_metadata or {}
                results = load_merged_evaluation_results(child_metadata.get('results', {}))
                if not results:
                    continue
                
                # Get evaluation parameters
                dataset_id = results.get('dataset_id')
                collection_id = results.get('collection_id')
                dataset_name = child_metadata.get('dataset_name', f'dataset_{dataset_id}')
                class_names = results.get('class_names', [])
                predictions = results.get('predictions', [])
                conf_threshold = results.get('conf_threshold', 0.25)
                iou_threshold = results.get('iou_threshold', 0.45)
                checkpoint = results.get('checkpoint', 'best')
                
                if not predictions:
                    continue
                
                # Get dataset and images
                dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
                if not dataset:
                    continue
                
                images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
                if collection_id is not None:
                    images_query = images_query.filter(Image.collection_id == collection_id)
                images = images_query.all()
                if not images:
                    continue
                
                # Initialize COCO structure
                coco_output = {
                    "info": {
                        "description": f"Evaluation results for {dataset_name}",
                        "date_created": datetime.now(timezone.utc).isoformat(),
                        "task_name": child_task.name,
                        "parent_task_id": task_id,
                        "dataset_id": dataset_id,
                        "dataset_name": dataset_name,
                        "model_checkpoint": checkpoint,
                        "conf_threshold": conf_threshold,
                        "iou_threshold": iou_threshold
                    },
                    "images": [],
                    "annotations": [],
                    "categories": []
                }
                
                # Add categories
                for idx, class_name in enumerate(class_names):
                    coco_output["categories"].append({
                        "id": idx,
                        "name": class_name,
                        "supercategory": "object"
                    })
                
                # Add images
                for img in images:
                    coco_output["images"].append({
                        "id": img.id,
                        "file_name": img.file_name,
                        "width": img.width or 0,
                        "height": img.height or 0,
                        "date_captured": img.uploaded_at.isoformat() if img.uploaded_at else None
                    })
                
                # Add predictions
                for idx, pred in enumerate(predictions, start=1):
                    segmentation = segmentation_to_coco_polygons(pred.get("segmentation"))

                    coco_output["annotations"].append({
                        "id": idx,
                        "image_id": pred['image_id'],
                        "category_id": pred['class_id'],
                        "bbox": pred['bbox'],
                        "score": pred['conf'],
                        "segmentation": segmentation
                    })
                
                # Add to ZIP: parent-eval slug + parent id + child id + dataset slug
                ds_slug_inner = _slug_for_attachment_filename(
                    str(dataset_name) if dataset_name else None,
                    f"dataset_{dataset_id}",
                )
                inner_name = (
                    f"{eval_slug_zip}_{task_id}_{child_task.id}_{ds_slug_inner}_coco.json"
                )
                zip_file.writestr(inner_name, json.dumps(coco_output, indent=2))
        
        zip_buffer.seek(0)

        zip_filename = f"{eval_slug_zip}_{task_id}_coco_all.zip"

        return StreamingResponse(
            zip_buffer,
            media_type="application/zip",
            headers={
                "Content-Disposition": _content_disposition_attachment(zip_filename),
            },
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error exporting all COCO results: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to export results: {str(e)}")


async def view_in_fiftyone(
    task_id: int,
    db: Session = Depends(get_db)
):
    """Open evaluation results in FiftyOne with predictions and ground truth"""
    try:
        # Get evaluation task
        task = db.query(Task).filter(Task.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        
        if task.task_type != 'model_evaluation':
            raise HTTPException(status_code=400, detail="Task is not an evaluation task")
        
        if task.status != 'completed':
            raise HTTPException(status_code=400, detail="Evaluation not completed")
        
        # Get results from metadata
        metadata = task.task_metadata or {}
        results = load_merged_evaluation_results(metadata.get('results', {}))
        if not results:
            raise HTTPException(status_code=404, detail="No evaluation results found")
        
        dataset_id = results.get('dataset_id')
        collection_id = results.get('collection_id')
        class_names = results.get('class_names', [])
        predictions = results.get('predictions', [])
        annotation_file_id = metadata.get('annotation_file_id')
        if not predictions:
            raise HTTPException(
                status_code=400,
                detail="No predictions available for this evaluation. Run evaluation with detectable outputs first."
            )
        
        # Get dataset
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        project_id = dataset.project_id
        
        # Get images
        images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
        if collection_id is not None:
            images_query = images_query.filter(Image.collection_id == collection_id)
        images = images_query.all()
        if not images:
            raise HTTPException(status_code=400, detail="No images found in dataset")
        
        # Create image lookup
        images_by_id = {img.id: img for img in images}

        ground_truth_by_image = _build_fiftyone_ground_truth_by_image(
            results=results,
            images_by_id=images_by_id,
            annotation_file_id=annotation_file_id,
            class_names=class_names,
            db=db,
        )

        # Organize predictions by image
        predictions_by_image = {}
        for pred in predictions:
            img_id = pred['image_id']
            if img_id not in predictions_by_image:
                predictions_by_image[img_id] = []
            
            if img_id in images_by_id:
                img = images_by_id[img_id]
                bbox_xywh = pred['bbox']
                
                # Normalize bbox to [0, 1] range for FiftyOne
                if img.width and img.height:
                    predictions_by_image[img_id].append({
                        'label': class_names[pred['class_id']] if pred['class_id'] < len(class_names) else 'unknown',
                        'bbox': [
                            bbox_xywh[0] / img.width,
                            bbox_xywh[1] / img.height,
                            bbox_xywh[2] / img.width,
                            bbox_xywh[3] / img.height
                        ],
                        'confidence': pred['conf']
                    })
        
        from app.services.dataset_fiftyone_service import _filesystem_path_for_image
        import base64
        
        image_dict = {}
        for img in images:
            fs = _filesystem_path_for_image(
                img, project_id, dataset_id, collection_id=collection_id
            )
            entry = {
                "file_name": img.file_name,
                "width": img.width or 1,
                "height": img.height or 1,
            }
            if fs is not None:
                entry["fs_path"] = str(fs)
            image_dict[str(img.id)] = entry

        image_dict_b64 = base64.b64encode(json.dumps(image_dict).encode()).decode()

        # Convert image_id keys to strings in predictions and ground truth
        predictions_by_image_str = {str(k): v for k, v in predictions_by_image.items()}
        ground_truth_by_image_str = {str(k): v for k, v in ground_truth_by_image.items()}
        predictions_b64 = base64.b64encode(json.dumps(predictions_by_image_str).encode()).decode()
        ground_truth_b64 = base64.b64encode(json.dumps(ground_truth_by_image_str).encode()).decode()
        
        # Create Python script to launch FiftyOne
        script_content = f"""
import fiftyone as fo
import json
import base64 as _b64
from pathlib import Path

# Create dataset
dataset_name = "eval_task_{task_id}"

# Delete if exists
if dataset_name in fo.list_datasets():
    fo.delete_dataset(dataset_name)

dataset = fo.Dataset(dataset_name)
dataset.persistent = False

# Add samples
samples = []
predictions_by_image = json.loads(_b64.b64decode('''{predictions_b64}''').decode())
ground_truth_by_image = json.loads(_b64.b64decode('''{ground_truth_b64}''').decode())
image_dict = json.loads(_b64.b64decode('''{image_dict_b64}''').decode())

_projects_root = Path("projects")
if not _projects_root.exists():
    _projects_root = Path("/app/projects")
_data_root = Path("data")

for img_id, img_info in image_dict.items():
    img_path = None
    fp = img_info.get('fs_path')
    if fp:
        img_path = Path(fp)
    
    if not img_path or not img_path.exists():
        img_path = _projects_root / "{project_id}" / "{dataset_id}" / "images" / img_info['file_name']
    
    if not img_path.exists():
        img_path = _data_root / "images" / "{dataset_id}" / img_info['file_name']
    
    if not img_path.exists():
        continue
    
    sample = fo.Sample(filepath=str(img_path))
    
    # Add predictions
    if img_id in predictions_by_image:
        detections = []
        for pred in predictions_by_image[img_id]:
            detection = fo.Detection(
                label=pred['label'],
                bounding_box=pred['bbox'],
                confidence=pred['confidence']
            )
            detections.append(detection)
        sample["predictions"] = fo.Detections(detections=detections)
    
    # Add ground truth
    if img_id in ground_truth_by_image:
        detections = []
        for gt in ground_truth_by_image[img_id]:
            detection = fo.Detection(
                label=gt['label'],
                bounding_box=gt['bbox'],
                confidence=gt['confidence']
            )
            detections.append(detection)
        sample["ground_truth"] = fo.Detections(detections=detections)
    
    samples.append(sample)

dataset.add_samples(samples)

total_predictions = sum(len(preds) for preds in predictions_by_image.values())
total_gt = sum(len(gts) for gts in ground_truth_by_image.values())
print(f"Loaded {{len(samples)}} samples into FiftyOne")
print(f"Classes: {class_names}")
print(f"Predictions: {{total_predictions}} total detections")
print(f"Ground truth: {{total_gt}} annotations")

# Launch the app - bind to 0.0.0.0 to make it accessible from outside Docker
import signal
import sys

def signal_handler(sig, frame):
    print('Shutting down FiftyOne...')
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

print('Launching FiftyOne app on port 5151...')
session = fo.launch_app(dataset, port=5151, address="0.0.0.0")
print('FiftyOne app launched successfully')
print('Keeping session alive...')

# Keep the session alive indefinitely
session.wait(-1)
"""
        
        # Write script to temp file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(script_content)
            script_path = f.name
        
        # Launch FiftyOne in background
        try:
            import time
            
            process = subprocess.Popen(
                ['python', script_path],
                stdout=open('/tmp/fiftyone_stdout.log', 'w'),
                stderr=open('/tmp/fiftyone_stderr.log', 'w'),
                env={**os.environ, 'FIFTYONE_DEFAULT_APP_PORT': '5151', 'FIFTYONE_DEFAULT_APP_ADDRESS': '0.0.0.0'},
                start_new_session=True
            )
            
            time.sleep(2)
            
            poll_result = process.poll()
            if poll_result is not None:
                try:
                    with open('/tmp/fiftyone_stderr.log', 'r') as f:
                        stderr_content = f.read()
                    logger.error(f"FiftyOne process exited with code {poll_result}: {stderr_content}")
                    raise HTTPException(status_code=500, detail=f"FiftyOne failed to start: {stderr_content[:500]}")
                except FileNotFoundError:
                    raise HTTPException(status_code=500, detail=f"FiftyOne failed to start with exit code {poll_result}")
            
            logger.info(f"Launched FiftyOne for evaluation task {task_id} with PID {process.pid}")
            
            return {
                "success": True,
                "message": "FiftyOne is starting. The app will open in a new window at http://localhost:5151",
                "url": "http://localhost:5151"
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to launch FiftyOne: {e}", exc_info=True)
            try:
                os.unlink(script_path)
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to launch FiftyOne: {str(e)}")
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error preparing FiftyOne view: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to prepare FiftyOne view: {str(e)}")

