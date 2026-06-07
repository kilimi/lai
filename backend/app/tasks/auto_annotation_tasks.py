"""
Celery tasks for auto-annotation with AI models (YOLO).
"""
import os
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Optional
import numpy as np
from PIL import Image as PILImage
import uuid

from celery import Task
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.gpu_app import celery_app
from app.models import (
    Task as TaskModel, 
    Dataset, 
    Image, 
    AnnotationFile, 
    Annotation, 
    AnnotationClass,
    AnnotationFileImage
)

logger = logging.getLogger(__name__)

# Database setup for Celery workers
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db/lai_db')
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class AutoAnnotationTask(Task):
    """Base task for auto-annotation with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails"""
        logger.error(f"Auto-annotation task {task_id} failed: {exc}")
        
        # Update task status in database
        db = SessionLocal()
        try:
            if args and len(args) > 0:
                db_task_id = args[0]
                task = db.query(TaskModel).filter(TaskModel.id == db_task_id).first()
                if task:
                    task.status = 'failed'
                    task.completed_at = datetime.utcnow()
                    task.error_message = str(exc)
                    db.commit()
        finally:
            db.close()


def convert_yolo_to_coco_bbox(yolo_bbox: List[float], img_width: int, img_height: int) -> List[float]:
    """
    Convert YOLO format (x_center, y_center, width, height) normalized to COCO format (x, y, width, height) in pixels
    """
    x_center, y_center, width, height = yolo_bbox
    
    # Convert from normalized to pixels
    x_center_px = x_center * img_width
    y_center_px = y_center * img_height
    width_px = width * img_width
    height_px = height * img_height
    
    # Convert from center to top-left
    x = x_center_px - (width_px / 2)
    y = y_center_px - (height_px / 2)
    
    return [x, y, width_px, height_px]


def polygon_to_bbox(polygon: List[float]) -> List[float]:
    """Convert polygon points to bounding box [x, y, width, height]"""
    if not polygon or len(polygon) < 2:
        return [0, 0, 0, 0]
    
    # Polygon is flat list [x1, y1, x2, y2, ...]
    x_coords = [polygon[i] for i in range(0, len(polygon), 2)]
    y_coords = [polygon[i] for i in range(1, len(polygon), 2)]
    
    min_x = min(x_coords)
    max_x = max(x_coords)
    min_y = min(y_coords)
    max_y = max(y_coords)
    
    return [min_x, min_y, max_x - min_x, max_y - min_y]


def calculate_polygon_area(polygon: List[float]) -> float:
    """Calculate area of polygon using shoelace formula"""
    if not polygon or len(polygon) < 6:  # Need at least 3 points
        return 0.0
    
    # Polygon is flat list [x1, y1, x2, y2, ...]
    n = len(polygon) // 2
    area = 0.0
    
    for i in range(n):
        j = (i + 1) % n
        x1 = polygon[i * 2]
        y1 = polygon[i * 2 + 1]
        x2 = polygon[j * 2]
        y2 = polygon[j * 2 + 1]
        area += x1 * y2
        area -= x2 * y1
    
    return abs(area) / 2.0


@celery_app.task(base=AutoAnnotationTask, bind=True, name='app.tasks.auto_annotation_tasks.auto_annotate_yolo')
def auto_annotate_yolo(
    self,
    task_id: int,
    model_path: str,
    dataset_id: int,
    class_names: List[str],
    annotation_name: str,
    conf_threshold: float = 0.25,
    iou_threshold: float = 0.45,
    use_segmentation: bool = True
):
    """
    Auto-annotate dataset using YOLO model
    
    Args:
        task_id: Database task ID
        model_path: Path to YOLO model file (.pt)
        dataset_id: Dataset ID to annotate
        class_names: List of class names
        annotation_name: Name for the annotation file
        conf_threshold: Confidence threshold for detections
        iou_threshold: IoU threshold for NMS
        use_segmentation: Whether to use segmentation (if model supports it)
    """
    from app.tasks.training_common import get_ultralytics_yolo
    YOLO = get_ultralytics_yolo()
    db = SessionLocal()
    
    try:
        logger.info(f"Starting auto-annotation task {task_id} for dataset {dataset_id}")
        
        # Get task from database
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")
        
        # Update task status
        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 0
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'loading_model'
        }
        db.commit()
        
        # Load YOLO model
        logger.info(f"Loading YOLO model from {model_path}")
        if not os.path.exists(model_path):
            raise ValueError(f"Model file not found: {model_path}")
        
        model = YOLO(model_path)
        
        # Check if model supports segmentation
        model_task = getattr(model, 'task', 'detect')
        supports_segmentation = model_task in ['segment', 'segmentation']
        use_seg = use_segmentation and supports_segmentation
        
        logger.info(f"Model task type: {model_task}, using segmentation: {use_seg}")
        
        task.progress = 10
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'loading_dataset'
        }
        db.commit()
        
        # Get dataset
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            raise ValueError(f"Dataset {dataset_id} not found")
        
        md = task.task_metadata or {}
        cid_raw = md.get("collection_id")
        cid = None
        if cid_raw is not None:
            try:
                cid = int(cid_raw)
            except (TypeError, ValueError):
                cid = None
        q_img = db.query(Image).filter(Image.dataset_id == dataset_id)
        if cid is not None:
            q_img = q_img.filter(Image.collection_id == cid)
        images = q_img.order_by(Image.id.asc()).all()
        if not images:
            raise ValueError("No images found in dataset")
        
        logger.info(
            f"Found {len(images)} images to annotate"
            + (f" (collection_id={cid})" if cid is not None else " (all collections)")
        )
        
        task.progress = 20
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'running_inference',
            'total_images': len(images),
            'processed_images': 0
        }
        db.commit()
        
        # Get project_id for constructing image paths
        project_id = dataset.project_id
        if not project_id:
            raise ValueError("Dataset does not belong to a project")
        
        # Create annotation file
        annotation_file_id = str(uuid.uuid4())
        
        annotation_file = AnnotationFile(
            id=annotation_file_id,
            dataset_id=dataset_id,
            name=annotation_name if annotation_name.endswith('.json') else f"{annotation_name}.json",
            format="COCO",
            type="Segmentation (mask+bbox)" if use_seg else "Object Detection (bbox)",
            is_processed=False,
            processing_status="processing"
        )
        
        db.add(annotation_file)
        db.commit()
        
        logger.info(f"Created annotation file {annotation_file_id}")
        
        # Create or get annotation classes
        annotation_classes = {}
        for idx, class_name in enumerate(class_names):
            # Check if class already exists
            existing_class = db.query(AnnotationClass).filter(
                AnnotationClass.annotation_file_id == annotation_file_id,
                AnnotationClass.name == class_name
            ).first()
            
            if existing_class:
                annotation_classes[class_name] = existing_class
            else:
                ann_class = AnnotationClass(
                    id=str(uuid.uuid4()),
                    annotation_file_id=annotation_file_id,
                    name=class_name,
                    category_id=idx + 1
                )
                db.add(ann_class)
                annotation_classes[class_name] = ann_class
        
        db.commit()
        
        # Store statistics
        class_counts = {name: 0 for name in class_names}
        total_annotations = 0
        processed_images = 0
        
        # Run inference on each image
        for img_idx, img in enumerate(images):
            # Construct image path
            img_path = Path("projects") / str(project_id) / str(dataset_id) / "images" / img.file_name
            
            # Fallback to old structure if new path doesn't exist
            if not img_path.exists():
                img_path = Path("data") / "images" / str(dataset_id) / img.file_name
            
            if not img_path.exists():
                logger.warning(f"Image file not found: {img_path}")
                continue
            
            # Run inference
            try:
                results = model.predict(
                    source=str(img_path),
                    conf=conf_threshold,
                    iou=iou_threshold,
                    verbose=False,
                    save=False
                )
            except Exception as e:
                logger.warning(f"Failed to run inference on {img_path}: {e}")
                continue
            
            if not results or len(results) == 0:
                continue
            
            result = results[0]
            
            # Get image dimensions
            img_height, img_width = result.orig_shape
            
            # Create AnnotationFileImage record
            ann_file_img = AnnotationFileImage(
                id=str(uuid.uuid4()),
                annotation_file_id=annotation_file_id,
                image_id=img.id,
                file_name=img.file_name,
                width=img_width,
                height=img_height
            )
            db.add(ann_file_img)
            
            image_ann_count = 0
            
            # Process detections
            if result.boxes and len(result.boxes) > 0:
                for box_idx, box in enumerate(result.boxes):
                    class_id = int(box.cls.item())
                    confidence = float(box.conf.item())
                    
                    if class_id >= len(class_names):
                        logger.warning(f"Class ID {class_id} out of range for image {img.file_name}")
                        continue
                    
                    class_name = class_names[class_id]
                    
                    # Get bounding box (xyxy format)
                    xyxy = box.xyxy[0].cpu().numpy()
                    x1, y1, x2, y2 = xyxy
                    
                    # Convert to COCO format (x, y, width, height)
                    bbox_x = float(x1)
                    bbox_y = float(y1)
                    bbox_width = float(x2 - x1)
                    bbox_height = float(y2 - y1)
                    bbox = [bbox_x, bbox_y, bbox_width, bbox_height]
                    
                    # Get segmentation if available
                    segmentation = None
                    area = bbox_width * bbox_height
                    
                    if use_seg and hasattr(result, 'masks') and result.masks is not None:
                        try:
                            # Get mask for this detection
                            if box_idx < len(result.masks.xy):
                                mask_coords = result.masks.xy[box_idx]
                                if len(mask_coords) > 0:
                                    # Flatten the coordinates into COCO segmentation format
                                    segmentation = [float(coord) for point in mask_coords for coord in point]
                                    
                                    # Calculate polygon area
                                    area = calculate_polygon_area(segmentation)
                        except Exception as e:
                            logger.warning(f"Failed to extract segmentation for box {box_idx}: {e}")
                    
                    # Create annotation
                    annotation = Annotation(
                        id=str(uuid.uuid4()),
                        annotation_file_id=annotation_file_id,
                        image_id=img.id,
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
                        iscrowd=0
                    )
                    
                    db.add(annotation)
                    class_counts[class_name] += 1
                    total_annotations += 1
                    image_ann_count += 1
            
            processed_images += 1
            
            # Update progress every 10 images
            if (img_idx + 1) % 10 == 0 or (img_idx + 1) == len(images):
                progress = 20 + int((processed_images / len(images)) * 70)
                task.progress = progress
                task.task_metadata = {
                    **task.task_metadata,
                    'processed_images': processed_images,
                    'total_annotations': total_annotations
                }
                db.commit()
                logger.info(f"Processed {processed_images}/{len(images)} images, {total_annotations} annotations")
        
        # Update annotation file statistics
        annotation_file.annotation_count = total_annotations
        annotation_file.image_count = processed_images
        annotation_file.category_count = len(class_names)
        annotation_file.statistics = {
            'class_counts': class_counts,
            'total_annotations': total_annotations
        }
        annotation_file.is_processed = True
        annotation_file.processing_status = "completed"
        db.commit()
        
        # Complete the task
        task.status = 'completed'
        task.progress = 100
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'completed',
            'total_annotations': total_annotations,
            'processed_images': processed_images,
            'class_counts': class_counts,
            'annotation_file_id': annotation_file_id
        }
        db.commit()
        
        logger.info(f"Auto-annotation task {task_id} completed: {total_annotations} annotations created")
        
    except Exception as e:
        logger.error(f"Auto-annotation task {task_id} failed: {e}", exc_info=True)
        
        # Update task with error
        try:
            task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
            if task:
                task.status = 'failed'
                task.completed_at = datetime.utcnow()
                task.error_message = str(e)
                db.commit()
        except:
            pass
        
        raise
    
    finally:
        db.close()
