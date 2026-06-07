"""Shared helpers for model evaluation (YOLO + MMYOLO)."""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np

from app.ml.predictions import from_ultralytics_result, to_eval_dicts
from app.models import Annotation, AnnotationFile, Image

logger = logging.getLogger(__name__)

MAX_CM_SAMPLES = 20


def _normalize_class_names(names: Any) -> List[str]:
    if isinstance(names, list):
        return [str(name) for name in names if str(name).strip()]
    if isinstance(names, dict):
        try:
            items = sorted(names.items(), key=lambda item: int(item[0]))
        except Exception:
            items = list(names.items())
        return [str(value) for _, value in items if str(value).strip()]
    return []


def resolve_evaluation_imgsz(
    task_metadata: Dict[str, Any],
    image_size_override: Optional[int] = None,
) -> Tuple[int, str]:
    """Resolve inference image size from request, training metadata, or env default."""
    if image_size_override is not None:
        try:
            parsed = int(image_size_override)
            if parsed > 0:
                return parsed, "request"
        except (TypeError, ValueError):
            pass

    for block_key in ("training_params", "training_config"):
        block = task_metadata.get(block_key) or {}
        if not isinstance(block, dict):
            continue
        for field in ("image_size", "imgsz"):
            raw = block.get(field)
            if raw is None:
                continue
            try:
                parsed = int(raw)
            except (TypeError, ValueError):
                continue
            if parsed > 0:
                return parsed, f"{block_key}.{field}"

    for field in ("image_size", "imgsz"):
        raw = task_metadata.get(field)
        if raw is None:
            continue
        try:
            parsed = int(raw)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed, field

    return int(os.environ.get("LAI_EVAL_IMGSZ", "640") or 640), "env_default"


def resolve_evaluation_class_names(model: Any, task_metadata: Dict[str, Any]) -> Tuple[List[str], int]:
    """
    Resolve class names and class count for evaluation.

    The checkpoint's model.names / model.nc is authoritative for inference output
    IDs. Training metadata is used for display names when counts match.
    """
    meta_names = _normalize_class_names(
        task_metadata.get("class_names") or task_metadata.get("classes") or []
    )

    model_names_raw = getattr(model, "names", None)
    model_names: List[str] = []
    if model_names_raw:
        model_names = _normalize_class_names(model_names_raw)

    nc = 0
    try:
        nc = int(getattr(getattr(model, "model", None), "nc", 0) or 0)
    except (TypeError, ValueError):
        nc = 0
    if nc <= 0 and model_names:
        nc = len(model_names)

    if meta_names and nc > 0 and len(meta_names) == nc:
        return meta_names, nc

    if model_names and nc > 0:
        if meta_names and len(meta_names) != nc:
            logger.warning(
                "Training class_names count (%s) != model nc (%s); using model.names %s",
                len(meta_names),
                nc,
                model_names,
            )
        return model_names, nc

    if meta_names:
        return meta_names, len(meta_names)

    raise ValueError("No class names found in training task or model checkpoint")


def extract_yolo_image_predictions(
    result: Any,
    *,
    image_id: int,
    num_classes: int,
    is_segmentation_model: bool,
    conf_threshold: float = 0.0,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """
    Parse Ultralytics Results into evaluation dicts.

    Returns (predictions, raw_box_count, dropped_by_class_filter).
    """
    records = from_ultralytics_result(
        result,
        image_id=image_id,
        conf_threshold=conf_threshold,
    )
    raw_count = len(records)
    kept = [rec for rec in records if 0 <= rec.class_id < num_classes]
    dropped = raw_count - len(kept)

    if is_segmentation_model and kept and result is not None:
        boxes = getattr(result, "boxes", None)
        masks = getattr(result, "masks", None)
        if boxes is not None and masks is not None and hasattr(masks, "xy"):
            for idx, rec in enumerate(kept):
                try:
                    if idx < len(masks.xy):
                        mask = masks.xy[idx]
                        if mask is not None and len(mask) > 0:
                            rec.segmentation = [[float(v) for v in pt[:2]] for pt in mask]
                except (IndexError, AttributeError, TypeError):
                    continue

    return to_eval_dicts(kept), raw_count, dropped


def load_ground_truth_annotations(
    db,
    annotation_file_id: Optional[str],
    class_names: List[str],
) -> Tuple[bool, Dict[int, List[dict]]]:
    """Build image_id -> list of GT boxes in xyxy pixel coordinates."""
    if not annotation_file_id:
        return False, {}

    annotation_file = db.query(AnnotationFile).filter(AnnotationFile.id == annotation_file_id).first()
    if not annotation_file:
        logger.warning("Annotation file %s not found", annotation_file_id)
        return False, {}

    annotations = db.query(Annotation).filter(Annotation.annotation_file_id == annotation_file_id).all()
    logger.info("Loading %s ground truth annotations from %s", len(annotations), annotation_file_id)

    ann_image_ids = {ann.image_id for ann in annotations}
    image_dims = {
        img.id: (img.width or 1, img.height or 1)
        for img in db.query(Image).filter(Image.id.in_(ann_image_ids)).all()
    }

    ground_truth: Dict[int, List[dict]] = {}
    for ann in annotations:
        if ann.image_id not in ground_truth:
            ground_truth[ann.image_id] = []

        img_w, img_h = image_dims.get(ann.image_id, (1, 1))
        bbox_x = bbox_y = bbox_width = bbox_height = None

        if (
            ann.bbox_x is not None
            and ann.bbox_y is not None
            and ann.bbox_width is not None
            and ann.bbox_height is not None
        ):
            bbox_x = ann.bbox_x * img_w
            bbox_y = ann.bbox_y * img_h
            bbox_width = ann.bbox_width * img_w
            bbox_height = ann.bbox_height * img_h
        elif ann.bbox and isinstance(ann.bbox, list) and len(ann.bbox) >= 4:
            bbox_x, bbox_y, bbox_width, bbox_height = ann.bbox[0], ann.bbox[1], ann.bbox[2], ann.bbox[3]

        if bbox_x is None or bbox_y is None or bbox_width is None or bbox_height is None:
            logger.warning("Skipping annotation %s with incomplete bbox data", ann.id)
            continue

        class_id = -1
        if ann.category:
            ann_cat_lower = ann.category.lower()
            for idx_cn, cn in enumerate(class_names):
                if cn.lower() == ann_cat_lower:
                    class_id = idx_cn
                    break
            if class_id == -1:
                logger.warning(
                    "GT category '%s' not found in training class_names %s",
                    ann.category,
                    class_names,
                )

        ground_truth[ann.image_id].append(
            {
                "class_id": class_id,
                "bbox": [bbox_x, bbox_y, bbox_x + bbox_width, bbox_y + bbox_height],
            }
        )

    return True, ground_truth


def accumulate_image_metrics(
    *,
    img: Image,
    image_predictions: List[Dict[str, Any]],
    ground_truth_annotations: Dict[int, List[dict]],
    has_ground_truth: bool,
    class_names: List[str],
    num_classes: int,
    ignored_class_ids: Set[int],
    iou_threshold: float,
    confusion_matrix: np.ndarray,
    cm_samples: Dict[str, List[dict]],
    counters: Dict[str, int],
    calculate_iou,
) -> None:
    """Update confusion matrix and TP/FP/FN counters for one image."""

    def _add_cm_sample(row: int, col: int, sample: dict) -> None:
        key = f"{row}_{col}"
        if key not in cm_samples:
            cm_samples[key] = []
        if len(cm_samples[key]) < MAX_CM_SAMPLES:
            cm_samples[key].append(sample)

    if has_ground_truth and img.id in ground_truth_annotations:
        gt_boxes = ground_truth_annotations[img.id]
        pred_boxes = [
            {"class_id": pred["class_id"], "bbox": pred["bbox_xyxy"], "conf": pred["conf"]}
            for pred in image_predictions
        ]

        filtered_pred_boxes = [p for p in pred_boxes if p["class_id"] not in ignored_class_ids]
        filtered_gt_boxes = [
            g for g in gt_boxes if g["class_id"] not in ignored_class_ids and g["class_id"] >= 0
        ]

        matched_gt: Set[int] = set()
        matched_pred: Set[int] = set()

        for i, pred in enumerate(filtered_pred_boxes):
            best_iou = 0.0
            best_gt_idx = -1
            for j, gt in enumerate(filtered_gt_boxes):
                if j in matched_gt:
                    continue
                iou = calculate_iou(pred["bbox"], gt["bbox"])
                if iou > best_iou:
                    best_iou = iou
                    best_gt_idx = j

            if best_iou >= iou_threshold and best_gt_idx >= 0:
                matched_pred.add(i)
                matched_gt.add(best_gt_idx)
                gt_class = filtered_gt_boxes[best_gt_idx]["class_id"]
                pred_class = pred["class_id"]
                if gt_class >= 0 and pred_class >= 0:
                    confusion_matrix[gt_class][pred_class] += 1
                    _add_cm_sample(
                        gt_class,
                        pred_class,
                        {
                            "image_id": img.id,
                            "file_name": img.file_name,
                            "pred_bbox": pred["bbox"],
                            "gt_bbox": filtered_gt_boxes[best_gt_idx]["bbox"],
                            "pred_class_name": class_names[pred_class],
                            "gt_class_name": class_names[gt_class],
                            "conf": float(pred["conf"]),
                            "iou": float(best_iou),
                        },
                    )
                    if gt_class == pred_class:
                        counters["true_positives"] += 1
                    else:
                        counters["false_positives"] += 1
            else:
                counters["false_positives"] += 1
                if pred["class_id"] < num_classes:
                    confusion_matrix[num_classes][pred["class_id"]] += 1
                    _add_cm_sample(
                        num_classes,
                        pred["class_id"],
                        {
                            "image_id": img.id,
                            "file_name": img.file_name,
                            "pred_bbox": pred["bbox"],
                            "gt_bbox": None,
                            "pred_class_name": class_names[pred["class_id"]],
                            "gt_class_name": "background",
                            "conf": float(pred["conf"]),
                            "iou": float(best_iou),
                        },
                    )

        for j in range(len(filtered_gt_boxes)):
            if j not in matched_gt:
                gt_class = filtered_gt_boxes[j]["class_id"]
                if 0 <= gt_class < num_classes:
                    confusion_matrix[gt_class][num_classes] += 1
                    _add_cm_sample(
                        gt_class,
                        num_classes,
                        {
                            "image_id": img.id,
                            "file_name": img.file_name,
                            "pred_bbox": None,
                            "gt_bbox": filtered_gt_boxes[j]["bbox"],
                            "pred_class_name": "background",
                            "gt_class_name": class_names[gt_class],
                            "conf": 0.0,
                            "iou": 0.0,
                        },
                    )
        counters["false_negatives"] += len(filtered_gt_boxes) - len(matched_gt)

    elif has_ground_truth:
        counters["false_positives"] += sum(
            1 for p in image_predictions if p["class_id"] not in ignored_class_ids
        )
