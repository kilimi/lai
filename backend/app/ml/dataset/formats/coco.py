"""COCO format dataset writer for MMYOLO."""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.ml.dataset.builder import (
    copy_image_file,
    generate_safe_output_filename,
    read_image_dimensions,
    resolve_source_image_path,
)

logger = logging.getLogger(__name__)


def _annotation_has_bbox(ann: Any) -> bool:
    if isinstance(ann.bbox, list) and len(ann.bbox) >= 4:
        return True
    if isinstance(ann.bbox, dict):
        return True
    return ann.bbox_x is not None and ann.bbox_width is not None


def _annotation_has_segmentation(ann: Any) -> bool:
    seg = ann.segmentation
    if not seg or not isinstance(seg, list) or len(seg) == 0:
        return False
    try:
        raw = seg[0] if isinstance(seg[0], list) else seg
        return isinstance(raw, list) and len(raw) >= 6
    except (TypeError, IndexError):
        return False


def _extract_segmentation_polygon(ann: Any) -> Optional[List[float]]:
    if not _annotation_has_segmentation(ann):
        return None
    raw = ann.segmentation
    poly = raw[0] if isinstance(raw[0], list) else raw
    if not isinstance(poly, list) or len(poly) < 6:
        return None
    try:
        return [float(v) for v in poly]
    except (TypeError, ValueError):
        return None


def _bbox_xywh_from_polygon(
    poly: List[float], img_width: int, img_height: int
) -> List[float]:
    """COCO pixel bbox [x, y, w, h] from polygon (pixel or normalized coords)."""
    needs_norm = max((abs(v) for v in poly), default=0.0) <= 1.5
    xs, ys = [], []
    for i in range(0, len(poly) - 1, 2):
        x, y = float(poly[i]), float(poly[i + 1])
        if needs_norm:
            x *= img_width
            y *= img_height
        xs.append(x)
        ys.append(y)
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    return [x1, y1, max(1.0, x2 - x1), max(1.0, y2 - y1)]


def _coco_bbox_from_annotation(
    ann: Any, img_width: int, img_height: int
) -> Optional[List[float]]:
    """Return COCO [x, y, w, h] in pixel coordinates."""
    w = float(img_width) or 1.0
    h = float(img_height) or 1.0

    # Prefer normalized bbox_* columns (canonical in LAI DB) over legacy bbox JSON.
    if ann.bbox_x is not None and ann.bbox_width is not None:
        bw = float(ann.bbox_width or 0)
        bh = float(ann.bbox_height or 0)
        if bw > 0 and bh > 0:
            return [
                float(ann.bbox_x) * w,
                float(ann.bbox_y or 0) * h,
                bw * w,
                bh * h,
            ]

    if ann.bbox and isinstance(ann.bbox, list) and len(ann.bbox) >= 4:
        x, y, bw, bh = (float(v) for v in ann.bbox[:4])
        if max(abs(x), abs(y), abs(bw), abs(bh)) <= 1.5:
            return [x * w, y * h, bw * w, bh * h]
        return [x, y, bw, bh]
    if ann.bbox and isinstance(ann.bbox, dict):
        x = float(ann.bbox.get("x", 0))
        y = float(ann.bbox.get("y", 0))
        bw = float(ann.bbox.get("width", 0))
        bh = float(ann.bbox.get("height", 0))
        if max(abs(x), abs(y), abs(bw), abs(bh)) <= 1.5:
            return [x * w, y * h, bw * w, bh * h]
        return [x, y, bw, bh]
    poly = _extract_segmentation_polygon(ann)
    if poly is not None:
        return _bbox_xywh_from_polygon(poly, img_width, img_height)
    return None


def _resolve_annotation_class(db, ann: Any, annotation_file_id: str, class_mapping: Dict[str, int]):
    from app.models import AnnotationClass

    if ann.category_id is not None:
        ann_class = (
            db.query(AnnotationClass)
            .filter(
                AnnotationClass.annotation_file_id == annotation_file_id,
                AnnotationClass.category_id == ann.category_id,
            )
            .first()
        )
        if ann_class:
            return ann_class
    if ann.category:
        ann_class = (
            db.query(AnnotationClass)
            .filter(
                AnnotationClass.annotation_file_id == annotation_file_id,
                AnnotationClass.class_name == ann.category,
            )
            .first()
        )
        if ann_class:
            return ann_class
    return None


def _image_passes_task_filter(ann: Any, task: str) -> bool:
    has_bbox = _annotation_has_bbox(ann)
    has_seg = _annotation_has_segmentation(ann)
    if task == "segment":
        return has_seg
    if task == "oriented":
        return has_seg
    return has_bbox or has_seg


def prepare_coco_dataset(
    db,
    dataset_configs: List[Dict[str, Any]],
    output_dir: Path,
    task: str = "detect",
    remove_images_without_annotations: bool = True,
) -> Dict[str, Any]:
    """
    Prepare COCO JSON format dataset for MMYOLO/RTMDet training.

    Unlike YOLO .txt format, MMYOLO expects COCO JSON files:
      output_dir/annotations/train.json
      output_dir/annotations/val.json   (if val split > 0)
      output_dir/images/train/
      output_dir/images/val/

    Returns dict with keys:
      train_json, val_json (optional), class_names, class_count, image_counts
    """
    from app.models import Dataset, Image, Annotation, AnnotationClass, AnnotationFile, ImageCollection
    from app.tasks.yolo_training_helpers import generate_safe_output_filename

    annotations_dir = output_dir / "annotations"
    train_images_dir = output_dir / "images" / "train"
    val_images_dir = output_dir / "images" / "val"
    annotations_dir.mkdir(parents=True, exist_ok=True)
    train_images_dir.mkdir(parents=True, exist_ok=True)
    val_images_dir.mkdir(parents=True, exist_ok=True)

    # ── 1. Collect unique class names across all configs ──────────────────────
    all_classes: set = set()
    for config in dataset_configs:
        annotation_file_id = config["annotation_file_id"]
        ann_classes = db.query(AnnotationClass).filter(
            AnnotationClass.annotation_file_id == annotation_file_id
        ).all()
        if not ann_classes:
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.dataset_id == config["dataset_id"]
            ).first()
            if ann_file:
                ann_classes = db.query(AnnotationClass).filter(
                    AnnotationClass.annotation_file_id == ann_file.id
                ).all()
        for c in ann_classes:
            all_classes.add(c.class_name)

    sorted_classes = sorted(all_classes)
    class_mapping = {name: idx for idx, name in enumerate(sorted_classes)}
    coco_categories = [
        {"id": idx + 1, "name": name, "supercategory": "object"}
        for idx, name in enumerate(sorted_classes)
    ]

    # ── 2. Build per-split COCO structures ────────────────────────────────────
    splits_data: Dict[str, Dict] = {
        "train": {"images": [], "annotations": [], "categories": coco_categories},
        "val": {"images": [], "annotations": [], "categories": coco_categories},
    }
    image_counts = {"train": 0, "val": 0}
    global_img_id = 1
    global_ann_id = 1
    has_any_segmentation = False

    for config in dataset_configs:
        dataset_id = config["dataset_id"]
        annotation_file_id = config["annotation_file_id"]
        image_collection = config.get("image_collection")
        split_pct = config.get("split", {"train": 80, "val": 20, "test": 0})

        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            logger.warning(f"Dataset {dataset_id} not found, skipping")
            continue

        images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
        if image_collection:
            images_query = images_query.join(Image.collection).filter(
                ImageCollection.name == image_collection
            )
        images = images_query.all()

        if not images:
            logger.warning(f"No images in dataset {dataset_id}, skipping")
            continue

        # Optionally filter images without valid annotations for this MMYOLO task
        if remove_images_without_annotations:
            filtered = []
            for img in images:
                anns = db.query(Annotation).filter(
                    Annotation.image_id == img.id,
                    Annotation.annotation_file_id == annotation_file_id,
                ).all()
                if any(_image_passes_task_filter(a, task) for a in anns):
                    filtered.append(img)
            images = filtered

        if not images:
            logger.warning(f"No images with valid annotations in dataset {dataset_id}, skipping")
            continue

        total = len(images)
        train_n = int(total * split_pct.get("train", 80) / 100)
        val_n = int(total * split_pct.get("val", 20) / 100)
        # Integer percent splits can drop images (e.g. 12 @ 80/20 → 9 train + 2 val, 1 lost).
        # Put any rounding remainder on train (COCO export has no test split; matches YOLO when test=0).
        split_assignments = (
            [("train", img) for img in images[:train_n]]
            + [("val", img) for img in images[train_n : train_n + val_n]]
            + [("train", img) for img in images[train_n + val_n :]]
        )

        for split_name, image in split_assignments:
            dst_dir = train_images_dir if split_name == "train" else val_images_dir

            src_path = resolve_source_image_path(image, dataset_id)
            safe_filename = generate_safe_output_filename(src_path.name, image.dataset_id)
            dst_path = dst_dir / safe_filename
            copy_image_file(src_path, dst_path)

            img_width, img_height = read_image_dimensions(
                image, dst_path if dst_path.exists() else src_path
            )
            
            coco_img = {
                "id": global_img_id,
                "file_name": safe_filename,
                "width": img_width,
                "height": img_height,
            }
            splits_data[split_name]["images"].append(coco_img)
            image_counts[split_name] += 1

            # Annotations
            anns = db.query(Annotation).filter(
                Annotation.image_id == image.id,
                Annotation.annotation_file_id == annotation_file_id,
            ).all()

            for ann in anns:
                ann_class = _resolve_annotation_class(
                    db, ann, annotation_file_id, class_mapping
                )
                if not ann_class:
                    logger.warning(
                        "No AnnotationClass for annotation %s (category_id=%s, category=%s)",
                        ann.id,
                        ann.category_id,
                        ann.category,
                    )
                    continue
                cat_id = class_mapping.get(ann_class.class_name)
                if cat_id is None:
                    logger.warning(f"Class name '{ann_class.class_name}' not in class_mapping")
                    continue
                coco_cat_id = cat_id + 1  # COCO categories are 1-indexed

                bbox_coco = _coco_bbox_from_annotation(ann, img_width, img_height)

                seg_poly = None
                poly = _extract_segmentation_polygon(ann)
                if poly is not None:
                    seg_poly = [poly]
                    has_any_segmentation = True

                if task == "segment":
                    if seg_poly is None:
                        continue
                    if bbox_coco is None:
                        bbox_coco = _bbox_xywh_from_polygon(poly, img_width, img_height)
                elif task == "oriented":
                    if seg_poly is None:
                        continue
                    if bbox_coco is None:
                        bbox_coco = _bbox_xywh_from_polygon(poly, img_width, img_height)
                else:
                    if bbox_coco is None:
                        continue

                area = (bbox_coco[2] * bbox_coco[3]) if bbox_coco else 0.0
                coco_ann: Dict[str, Any] = {
                    "id": global_ann_id,
                    "image_id": global_img_id,
                    "category_id": coco_cat_id,
                    "bbox": bbox_coco or [0, 0, 0, 0],
                    "area": area,
                    "iscrowd": 0,
                }
                if seg_poly is not None:
                    coco_ann["segmentation"] = seg_poly
                else:
                    coco_ann["segmentation"] = []

                splits_data[split_name]["annotations"].append(coco_ann)
                global_ann_id += 1

            global_img_id += 1

    # ── 3. Validate ───────────────────────────────────────────────────────────
    if not sorted_classes:
        raise ValueError("No annotation classes found. Make sure your datasets have annotations with classes defined.")

    total_train = len(splits_data["train"]["images"])
    total_val = len(splits_data["val"]["images"])
    if total_train == 0 and total_val == 0:
        if task == "segment":
            hint = (
                "RTMDet-Ins / segment task requires polygon (instance segmentation) annotations. "
                "BBox-only datasets cannot be used — add masks or train with RTMDet / YOLOv8 detection."
            )
        elif task == "oriented":
            hint = (
                "RTMDet-R / oriented task requires polygon annotations (used as rotated boxes). "
                "BBox-only datasets cannot be used — add polygons or use RTMDet detection."
            )
        else:
            hint = "Check that images exist on disk and annotations have valid bounding boxes."
        raise ValueError(f"No images were processed. {hint}")

    if task == "segment" and not has_any_segmentation:
        raise ValueError(
            "Task 'segment' requires segmentation (polygon) annotations, but none were found. "
            "Add polygon annotations or switch to task 'detect'."
        )

    # ── 4. Write JSON files ───────────────────────────────────────────────────
    train_json_path = annotations_dir / "train.json"
    with open(train_json_path, "w") as f:
        json.dump(splits_data["train"], f)

    result: Dict[str, Any] = {
        "train_json": str(train_json_path),
        "class_names": sorted_classes,
        "class_count": len(sorted_classes),
        "image_counts": image_counts,
    }

    if total_val > 0:
        val_json_path = annotations_dir / "val.json"
        with open(val_json_path, "w") as f:
            json.dump(splits_data["val"], f)
        result["val_json"] = str(val_json_path)

    logger.info(
        f"MMYOLO dataset prepared: {total_train} train, {total_val} val images, "
        f"{len(sorted_classes)} classes, task={task}"
    )
    return result