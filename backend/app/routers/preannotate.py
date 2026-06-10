from fastapi import APIRouter, Depends, HTTPException, Form
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any
import json
import asyncio
from datetime import datetime
import cv2
import numpy as np
from PIL import Image
import albumentations as A
from pathlib import Path
import os
import shutil
import logging

from .. import models, schemas
from ..auto_annotate_collection import resolve_auto_annotate_source_collection_id
from ..database import get_db
from ..model_weights_presence import (
    WEIGHTS_DOWNLOAD_NOTICE,
    is_auto_annotate_yolo_onnx_cached,
    is_depth_onnx_cached,
)
from ..foundation_models import (
    AUTO_ANNOTATE_YOLO_BASE,
    validate_auto_annotate_yolo_model,
)

# Create logger for this module
logger = logging.getLogger(__name__)

router = APIRouter()

# COCO class names
COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
    "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
    "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]

# Size label for tags (kept for depth models if extended later)
SIZE_LABELS = {"n": "nano", "s": "small", "m": "medium", "l": "large", "x": "xlarge"}


def _auto_annotate_tags(model_name: str, task_type: str) -> List[str]:
    """Build tags for auto-annotate: auto, model type, size, and task (detection/segmentation/classification)."""
    import re
    tags = ["auto"]
    task_label = {"detect": "detection", "segment": "segmentation", "classify": "classification"}.get(
        task_type, task_type
    )
    tags.append(task_label)
    if model_name.startswith("depth_anything"):
        # e.g. depth_anything_v2_small
        parts = model_name.split("_")
        if "v2" in parts:
            tags.insert(1, "depth_anything_v2")
        else:
            tags.insert(1, "depth_anything")
        size_part = parts[-1] if parts else ""
        if size_part:
            tags.insert(2, size_part)
    else:
        tags.insert(1, "yolo11")
        tags.insert(2, "medium")
    return tags


def load_yolo_onnx_runner(model_name: str, task_id: int, task_type: str = "detect"):
    """Load YOLO11m ONNX runner for Auto-Annotate."""
    from app.ml.inference.yolo_onnx_runner import YoloOnnxRunner

    validate_auto_annotate_yolo_model(model_name, task_type)
    logger.info(
        f"Task {task_id}: Loading YOLO ONNX model {AUTO_ANNOTATE_YOLO_BASE} "
        f"(task_type={task_type})"
    )
    runner = YoloOnnxRunner.for_auto_annotate(task_type, COCO_CLASSES)
    use_segmentation = task_type == "segment"
    is_classification = task_type == "classify"
    logger.info(
        f"Task {task_id}: ONNX runner ready — task={task_type}, "
        f"segmentation={use_segmentation}, classification={is_classification}"
    )
    return runner, use_segmentation, is_classification


def create_annotation_file_with_classes(
    db,
    dataset_id: int,
    annotation_file_name: str,
    use_segmentation: bool,
    task_id: int,
    tags: Optional[List[str]] = None,
    is_classification: bool = False,
):
    """Create annotation file and annotation classes. Optionally set tags (e.g. model type, size, task).
    For classification, type is set to 'Classification' and no initial classes are created (added on the fly)."""
    import uuid

    annotation_file_id = str(uuid.uuid4())
    if is_classification:
        file_type = "Classification"
    else:
        file_type = "Segmentation (mask+bbox)" if use_segmentation else "Object Detection (bbox)"
    annotation_file = models.AnnotationFile(
        id=annotation_file_id,
        dataset_id=dataset_id,
        name=annotation_file_name if annotation_file_name.endswith('.json') else f"{annotation_file_name}.json",
        format="COCO",
        type=file_type,
        is_processed=False,
        processing_status="processing",
    )
    if tags:
        annotation_file.tags = list(tags)
    db.add(annotation_file)
    db.commit()
    logger.info(f"Task {task_id}: Created annotation file {annotation_file_id}" + (f" type={file_type}" if is_classification else "") + (f" with tags {tags}" if tags else ""))
    
    # Create annotation classes only for detection/segmentation (COCO 80 classes); classification adds classes on the fly
    if not is_classification:
        for idx, class_name in enumerate(COCO_CLASSES):
            ann_class = models.AnnotationClass(
                annotation_file_id=annotation_file_id,
                class_name=class_name,
                category_id=idx + 1
            )
            db.add(ann_class)
        db.commit()
    
    return annotation_file_id


def get_or_create_annotation_class(db, annotation_file_id: str, class_name: str) -> int:
    """Get or create an AnnotationClass for this file and class; return category_id."""
    existing = db.query(models.AnnotationClass).filter(
        models.AnnotationClass.annotation_file_id == annotation_file_id,
        models.AnnotationClass.class_name == class_name,
    ).first()
    if existing:
        return existing.category_id
    max_id = db.query(models.AnnotationClass).filter(
        models.AnnotationClass.annotation_file_id == annotation_file_id,
    ).count()
    category_id = max_id + 1
    ann_class = models.AnnotationClass(
        annotation_file_id=annotation_file_id,
        class_name=class_name,
        category_id=category_id,
        count=0,
    )
    db.add(ann_class)
    db.commit()
    return category_id


def calculate_polygon_area(segmentation: List[float]) -> float:
    """Calculate area of polygon using shoelace formula"""
    n = len(segmentation) // 2
    if n < 3:
        return 0.0
    
    poly_area = 0.0
    for i in range(n):
        j = (i + 1) % n
        x_i, y_i = segmentation[i * 2], segmentation[i * 2 + 1]
        x_j, y_j = segmentation[j * 2], segmentation[j * 2 + 1]
        poly_area += x_i * y_j - x_j * y_i
    
    return abs(poly_area) / 2.0


def create_annotation_from_yolo_detection(
    db,
    det,
    annotation_file_id: str,
    image_id: int,
    dataset_id: int,
    *,
    img_width: int,
    img_height: int,
):
    """Create annotation object from YOLO ONNX detection."""
    class_id = det.class_id
    confidence = det.confidence

    if class_id >= len(COCO_CLASSES):
        return None

    class_name = COCO_CLASSES[class_id]
    x1, y1, x2, y2 = det.bbox_xyxy
    w = float(img_width or 1) or 1.0
    h = float(img_height or 1) or 1.0
    bbox_x = float(x1) / w
    bbox_y = float(y1) / h
    bbox_width = float(x2 - x1) / w
    bbox_height = float(y2 - y1) / h
    bbox = [bbox_x, bbox_y, bbox_width, bbox_height]
    area = bbox_width * bbox_height
    segmentation = det.segmentation
    if segmentation:
        area = calculate_polygon_area(segmentation) / (w * h)

    annotation = models.Annotation(
        annotation_file_id=annotation_file_id,
        image_id=image_id,
        dataset_id=dataset_id,
        category=class_name,
        category_id=class_id + 1,
        bbox_x=bbox_x,
        bbox_y=bbox_y,
        bbox_width=bbox_width,
        bbox_height=bbox_height,
        bbox=bbox,
        segmentation=segmentation,
        area=area,
        confidence=confidence,
    )
    db.add(annotation)
    return class_name


def _resolve_image_path(img, project_id: int, dataset_id: int) -> Optional[Path]:
    """Resolve on-disk path for a dataset image (collection subdirs, URL tails)."""
    from app.dataset_media_paths import resolve_dataset_image_path_from_models

    return resolve_dataset_image_path_from_models(
        img,
        dataset_id=int(dataset_id),
        project_id=int(project_id) if project_id else None,
    )


def process_single_image(db, runner, img, project_id: int, dataset_id: int,
                        annotation_file_id: str, class_counts: dict,
                        conf_threshold: float = 0.25):
    """Process a single image with YOLO ONNX inference and create annotations."""
    img_path = _resolve_image_path(img, project_id, dataset_id)
    if img_path is None:
        logger.warning(
            "Image not found for %s (id=%s, project_id=%s, dataset_id=%s, url=%s)",
            img.file_name,
            img.id,
            project_id,
            dataset_id,
            getattr(img, "url", None),
        )
        return 0

    logger.info(f"Processing image: {img_path} (size: {img_path.stat().st_size} bytes)")
    
    # Run ONNX inference
    try:
        detections, (img_height, img_width) = runner.predict_detect_or_segment(
            img_path, conf_threshold=conf_threshold, iou_threshold=0.45
        )
    except Exception as e:
        logger.error(f"Inference failed on {img_path}: {e}", exc_info=True)
        return 0

    if img.width != img_width or img.height != img_height:
        img.width = img_width
        img.height = img_height

    logger.info(f"Image {img.file_name}: shape=({img_height}, {img_width}), detections={len(detections)}")
    for i, det in enumerate(detections[:5]):
        cls_name = COCO_CLASSES[det.class_id] if det.class_id < len(COCO_CLASSES) else f"unknown_{det.class_id}"
        logger.info(
            f"  Detection {i}: class={cls_name}(id={det.class_id}), "
            f"conf={det.confidence:.3f}, xyxy={det.bbox_xyxy}"
        )
    
    # Create AnnotationFileImage
    ann_file_img = models.AnnotationFileImage(
        annotation_file_id=annotation_file_id,
        dataset_image_id=img.id,
        file_name=img.file_name,
        width=img_width,
        height=img_height
    )
    db.add(ann_file_img)
    
    annotations_count = 0
    for det in detections:
        class_name = create_annotation_from_yolo_detection(
            db,
            det,
            annotation_file_id,
            img.id,
            dataset_id,
            img_width=img_width,
            img_height=img_height,
        )
        if class_name:
            class_counts[class_name] += 1
            annotations_count += 1
    
    logger.info(f"Image {img.file_name}: created {annotations_count} annotations")
    return annotations_count


def process_single_image_classification(
    db,
    runner,
    img,
    project_id: int,
    annotation_file_id: str,
    dataset_id: int,
    class_counts: dict,
):
    """Run YOLO ONNX classification on one image."""
    img_path = _resolve_image_path(img, project_id, dataset_id)
    if img_path is None:
        logger.warning(f"Image not found for classification: {img.file_name} (project_id={project_id}, dataset_id={dataset_id}, url={getattr(img, 'url', None)})")
        return 0
    source_str = str(img_path)
    try:
        result = runner.predict_classify(source_str)
    except Exception as e:
        logger.error(f"Classification inference failed on {source_str}: {e}", exc_info=True)
        return 0

    top1_idx = result.class_id
    names = runner.class_names
    if top1_idx < len(names):
        class_name = names[top1_idx]
    else:
        class_name = f"class_{top1_idx}"
    confidence = result.confidence
    img_height, img_width = result.orig_shape
    if not img_width or not img_height:
        img_width = img.width or 1
        img_height = img.height or 1
    ann_file_img = models.AnnotationFileImage(
        annotation_file_id=annotation_file_id,
        dataset_image_id=img.id,
        file_name=img.file_name,
        width=img_width,
        height=img_height,
    )
    db.add(ann_file_img)
    category_id = get_or_create_annotation_class(db, annotation_file_id, class_name)
    class_counts[class_name] = class_counts.get(class_name, 0) + 1
    ann = models.Annotation(
        annotation_file_id=annotation_file_id,
        image_id=img.id,
        dataset_id=dataset_id,
        category=class_name,
        category_id=category_id,
        bbox=None,
        segmentation=None,
        area=None,
        confidence=confidence,
    )
    db.add(ann)
    db.commit()
    logger.info(f"Image {img.file_name}: classification -> {class_name}")
    return 1


def finalize_annotation_file(db, annotation_file_id: str, total_annotations: int, 
                             processed_images: int, class_counts: dict):
    """Update annotation file with final statistics. Remove classes with count 0 and renumber category_id."""
    annotation_file = db.query(models.AnnotationFile).filter(
        models.AnnotationFile.id == annotation_file_id
    ).first()
    
    if not annotation_file:
        return

    # Update count on each AnnotationClass from class_counts
    for ann_cls in db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_file_id
    ).all():
        ann_cls.count = class_counts.get(ann_cls.class_name, 0)
    db.commit()

    # Keep only classes that have at least one annotation
    used_class_names = [name for name, count in class_counts.items() if count > 0]
    if not used_class_names:
        annotation_file.annotation_count = total_annotations
        annotation_file.image_count = processed_images
        annotation_file.category_count = 0
        annotation_file.statistics = {
            'class_counts': class_counts,
            'total_annotations': total_annotations
        }
        annotation_file.is_processed = True
        annotation_file.processing_status = "completed"
        db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_file_id
        ).delete()
        db.commit()
        return

    # Delete classes with count 0
    db.query(models.AnnotationClass).filter(
        models.AnnotationClass.annotation_file_id == annotation_file_id,
        ~models.AnnotationClass.class_name.in_(used_class_names)
    ).delete(synchronize_session=False)
    db.commit()

    # Renumber category_id 1, 2, 3, ... for remaining classes (stable order by class name)
    remaining_classes = db.query(models.AnnotationClass).filter(
        models.AnnotationClass.annotation_file_id == annotation_file_id
    ).order_by(models.AnnotationClass.class_name).all()
    name_to_new_category_id = {}
    for idx, ann_cls in enumerate(remaining_classes):
        new_id = idx + 1
        name_to_new_category_id[ann_cls.class_name] = new_id
        ann_cls.category_id = new_id
    db.commit()

    # Update annotations to use new category_id
    for ann in db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_file_id
    ).all():
        if ann.category in name_to_new_category_id:
            ann.category_id = name_to_new_category_id[ann.category]
    db.commit()

    annotation_file.annotation_count = total_annotations
    annotation_file.image_count = processed_images
    annotation_file.category_count = len(remaining_classes)
    annotation_file.statistics = {
        'class_counts': {k: v for k, v in class_counts.items() if v > 0},
        'total_annotations': total_annotations
    }
    annotation_file.is_processed = True
    annotation_file.processing_status = "completed"
    db.commit()


@router.post("/preannotate")
async def start_preannotate(
    request: Dict[str, Any],
    db: Session = Depends(get_db)
):
    """Start auto-annotation with foundation model or depth estimation"""
    try:
        model_name = request.get("model_name")
        dataset_id = request.get("dataset_id")
        save_as = request.get("save_as")
        new_dataset_name = request.get("new_dataset_name")
        annotation_file_name = request.get("annotation_file_name")
        conf_threshold = request.get("conf_threshold", 0.25)
        task_type = request.get("task_type", "detect")
        environment = request.get("environment", "outdoor")
        model_size = request.get("model_size", "vitb")
        collection_id_raw = request.get("collection_id")
        collection_id: Optional[int] = None
        if collection_id_raw is not None and collection_id_raw != "":
            try:
                collection_id = int(collection_id_raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="collection_id must be an integer")

        if collection_id is not None:
            coll = db.query(models.ImageCollection).filter(
                models.ImageCollection.id == collection_id,
                models.ImageCollection.dataset_id == dataset_id,
            ).first()
            if not coll:
                raise HTTPException(
                    status_code=400,
                    detail="collection_id must belong to the selected dataset",
                )

        effective_collection_id = resolve_auto_annotate_source_collection_id(
            db, dataset_id, collection_id
        )
        
        if not model_name or not dataset_id:
            raise HTTPException(status_code=400, detail="model_name and dataset_id are required")

        is_depth_estimation = model_name.startswith("depth_anything")
        if not is_depth_estimation:
            try:
                validate_auto_annotate_yolo_model(model_name, task_type)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))

        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Create task record
        task_name = f"Generate depth maps for {dataset.name}" if is_depth_estimation else f"Auto-annotate {dataset.name} with {model_name}"
        task = models.Task(
            name=task_name,
            task_type="depth_estimation" if is_depth_estimation else "preannotate",
            status="pending",
            progress=0.0,
            project_id=dataset.project_id,
            created_at=datetime.utcnow(),
            task_metadata={
                "model_name": model_name,
                "dataset_id": dataset_id,
                "project_id": dataset.project_id,
                "save_as": save_as,
                "new_dataset_name": new_dataset_name,
                "annotation_file_name": annotation_file_name or f"Auto_{model_name}",
                "conf_threshold": conf_threshold,
                "task_type": task_type,
                "environment": environment,
                "model_size": model_size,
                **(
                    {"collection_id": effective_collection_id}
                    if effective_collection_id is not None
                    else {}
                ),
            }
        )
        db.add(task)
        db.commit()
        db.commit()
        db.refresh(task)

        if is_depth_estimation:
            from ..tasks.depth_estimation_tasks import generate_depth_maps

            celery_task = generate_depth_maps.delay(
                task.id,
                dataset_id,
                model_size,
                environment,
                save_as or "collection",
                new_dataset_name,
            )
            task.task_metadata = {**(task.task_metadata or {}), "celery_task_id": celery_task.id}
            db.commit()

            logger.info(
                "Started depth estimation task %s for dataset %s with model %s",
                task.id,
                dataset_id,
                model_name,
            )
            message = f"Depth estimation started with {model_name}"
        else:
            from ..tasks.preannotate_tasks import run_yolo_preannotate

            celery_task = run_yolo_preannotate.delay(
                task.id,
                model_name,
                dataset_id,
                conf_threshold,
                task_type,
            )
            task.task_metadata = {**(task.task_metadata or {}), "celery_task_id": celery_task.id}
            db.commit()

            logger.info(
                "Started preannotate task %s for dataset %s with model %s",
                task.id,
                dataset_id,
                model_name,
            )
            message = f"Auto-annotation started with {model_name}"

        weights_cached = (
            is_depth_onnx_cached(model_size, environment)
            if is_depth_estimation
            else is_auto_annotate_yolo_onnx_cached(task_type)
        )

        return {
            "success": True,
            "task_id": task.id,
            "message": message,
            "weights_download_expected": not weights_cached,
            "weights_download_notice": None if weights_cached else WEIGHTS_DOWNLOAD_NOTICE,
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "progress": task.progress
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting preannotate: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))