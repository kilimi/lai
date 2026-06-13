"""
Celery tasks for dataset augmentation operations using Albumentations.
"""
import os
import json
import shutil
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple
import numpy as np
from PIL import Image as PILImage
import cv2

try:
    import albumentations as A
except ImportError:
    A = None

from celery import Task
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
import uuid

from app.celery.general_app import celery_app
from app.models import Task as TaskModel, Dataset, Image, ImageCollection, Annotation, Augmentation, AnnotationFile, AnnotationClass, AnnotationFileImage
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.services.annotation_processing import validate_and_normalize_segmentation, annotation_bbox_pixel_xywh
from app.tasks.yolo_training_helpers import generate_safe_output_filename

logger = logging.getLogger(__name__)

# Database setup for Celery workers
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db/lai_db')
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _parse_annotation_segmentation(seg: Any) -> Any:
    """DB/JSON may store segmentation as a JSON string — normalize to object."""
    if seg is None:
        return None
    if isinstance(seg, str):
        s = seg.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except (json.JSONDecodeError, TypeError):
            return None
    return seg


def _segmentation_mask_flags(
    raw_seg: Any, image_width: int, image_height: int
) -> Tuple[Any, bool, bool]:
    """
    Returns (normalized_segmentation, has_polygon_masks, has_rle_mask).
    Polygon lists are validated/clamped like COCO import; RLE dicts are detected but not expanded here.
    """
    parsed = _parse_annotation_segmentation(raw_seg)
    if not parsed:
        return None, False, False
    if isinstance(parsed, dict) and ("counts" in parsed or "size" in parsed):
        return parsed, False, True
    norm = validate_and_normalize_segmentation(
        parsed, image_width, image_height, normalize=False
    )
    if isinstance(norm, list) and len(norm) > 0:
        return norm, True, False
    return None, False, False


def _clip_segmentation_polygons(
    seg: Optional[List], width: int, height: int
) -> Optional[List]:
    """Clamp all polygon vertices to image pixel bounds (inclusive)."""
    if not seg or width <= 0 or height <= 0:
        return seg
    w1 = max(0, width - 1)
    h1 = max(0, height - 1)
    out: List[List[int]] = []
    for poly in seg:
        if not isinstance(poly, list) or len(poly) < 6:
            continue
        clipped: List[int] = []
        for i in range(0, len(poly), 2):
            if i + 1 >= len(poly):
                break
            try:
                xf = float(np.asarray(poly[i]).item())
                yf = float(np.asarray(poly[i + 1]).item())
            except (TypeError, ValueError, IndexError):
                continue
            if np.isnan(xf) or np.isnan(yf) or np.isinf(xf) or np.isinf(yf):
                continue
            xi = int(round(max(0.0, min(xf, float(w1)))))
            yi = int(round(max(0.0, min(yf, float(h1)))))
            clipped.extend([xi, yi])
        if len(clipped) >= 6:
            out.append(clipped)
    return out if out else None


def _build_dataset_selection_filters(
    task_metadata: Dict[str, Any],
) -> Tuple[Dict[int, Optional[int]], Dict[int, Optional[str]]]:
    """Parse per-dataset collection + annotation-file selection from task metadata."""
    dataset_collection_filter: Dict[int, Optional[int]] = {}
    dataset_annotation_file_filter: Dict[int, Optional[str]] = {}

    for cfg in task_metadata.get("annotation_file_configs", []) or []:
        try:
            ds_id = int(cfg.get("dataset_id"))
        except (TypeError, ValueError):
            continue

        ann_file_raw = cfg.get("annotation_file_id")
        if ann_file_raw in (None, ""):
            dataset_annotation_file_filter[ds_id] = None
        else:
            dataset_annotation_file_filter[ds_id] = str(ann_file_raw)

        coll_raw = cfg.get("collection_id")
        if coll_raw is None:
            dataset_collection_filter[ds_id] = None
            continue
        try:
            dataset_collection_filter[ds_id] = int(coll_raw)
        except (TypeError, ValueError):
            dataset_collection_filter[ds_id] = None

    return dataset_collection_filter, dataset_annotation_file_filter


def _apply_selected_annotation_file_filter(query, dataset_id: int, dataset_annotation_file_filter: Dict[int, Optional[str]]):
    """Limit query to selected annotation_file_id for a dataset when configured."""
    selected_ann_file_id = dataset_annotation_file_filter.get(dataset_id)
    if selected_ann_file_id:
        return query.filter(Annotation.annotation_file_id == selected_ann_file_id)
    return query


class AugmentationTask(Task):
    """Base task for augmentation with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails"""
        logger.error(f"Augmentation task {task_id} failed: {exc}")
        
        # Update task status in database
        db = SessionLocal()
        try:
            if args and len(args) > 0:
                db_task_id = args[0]
                task = db.query(TaskModel).filter(TaskModel.id == db_task_id).first()
                if task:
                    # Don't overwrite cancelled/stopped status
                    if task.status in ('cancelled', 'stopped', 'paused'):
                        logger.info(f"Task {db_task_id} already has status '{task.status}', not overwriting with failed")
                    else:
                        task.status = 'failed'
                        task.completed_at = datetime.utcnow()
                        task.error_message = str(exc)
                        logger.error(f"Task {db_task_id} marked as failed: {exc}")
                    db.commit()
        finally:
            db.close()


def create_albumentations_transform(
    augmentation_methods: List[str],
    method_parameters: Dict[str, Any],
    *,
    include_keypoint_params: bool = False,
) -> 'A.Compose':
    """
    Create an Albumentations transform pipeline based on the selected methods and parameters.
    """
    if A is None:
        raise ImportError("Albumentations is not installed. Run: pip install albumentations")
    
    transforms = []
    
    for method in augmentation_methods:
        if method == 'rotation':
            params = method_parameters.get('rotation', {})
            min_angle = params.get('min_angle', -30)
            max_angle = params.get('max_angle', 30)
            transforms.append(A.Rotate(limit=(min_angle, max_angle), p=1.0, border_mode=cv2.BORDER_CONSTANT))
            
        elif method == 'flip_horizontal':
            transforms.append(A.HorizontalFlip(p=1.0))
            
        elif method == 'flip_vertical':
            transforms.append(A.VerticalFlip(p=1.0))
            
        elif method == 'scale':
            params = method_parameters.get('scale', {})
            min_scale = params.get('min_scale', 0.8)
            max_scale = params.get('max_scale', 1.2)
            transforms.append(A.RandomScale(scale_limit=(min_scale - 1.0, max_scale - 1.0), p=1.0))
            
        elif method == 'brightness':
            params = method_parameters.get('brightness', {})
            factor = params.get('factor', 0.2)
            # Albumentations v2 removed RandomBrightness/RandomContrast.
            # Use RandomBrightnessContrast with one side disabled.
            transforms.append(
                A.RandomBrightnessContrast(
                    brightness_limit=factor,
                    contrast_limit=0,
                    p=1.0,
                )
            )
            
        elif method == 'contrast':
            params = method_parameters.get('contrast', {})
            factor = params.get('factor', 0.2)
            transforms.append(
                A.RandomBrightnessContrast(
                    brightness_limit=0,
                    contrast_limit=factor,
                    p=1.0,
                )
            )
            
        elif method == 'saturation':
            params = method_parameters.get('saturation', {})
            factor = params.get('factor', 0.2)
            transforms.append(A.ColorJitter(saturation=factor, p=1.0))
            
        elif method == 'hue_shift':
            params = method_parameters.get('hue_shift', {})
            max_shift = params.get('max_shift', 0.1)
            transforms.append(A.HueSaturationValue(hue_shift_limit=int(max_shift * 180), p=1.0))
            
        elif method == 'to_gray':
            # Convert image to grayscale (single channel replicated 3 times)
            transforms.append(A.ToGray(p=1.0))
            
        elif method == 'color_space':
            # Transform to different color space and optionally keep single channel
            params = method_parameters.get('color_space', {})
            color_space = params.get('color_space', 'HSV')
            channel = params.get('channel', 'all')
            
            # Create closure with proper parameter capture
            def make_color_space_transform(cs, ch):
                def color_space_transform(image, **kwargs):
                    # Convert from RGB to target color space
                    if cs == 'HSV':
                        converted = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
                    elif cs == 'Lab':
                        converted = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
                    elif cs == 'YCrCb':
                        converted = cv2.cvtColor(image, cv2.COLOR_RGB2YCrCb)
                    elif cs == 'HLS':
                        converted = cv2.cvtColor(image, cv2.COLOR_RGB2HLS)
                    else:
                        converted = image
                    
                    # Handle channel selection
                    if ch == 'all':
                        # Return the full converted color space
                        # The values will be saved as-is (HSV values as RGB pixels)
                        return converted
                    elif isinstance(ch, (int, str)) and str(ch).isdigit():
                        ch_idx = int(ch)
                        if 0 <= ch_idx < 3:
                            # Extract single channel and replicate to 3 channels
                            single_channel = converted[:, :, ch_idx]
                            return cv2.merge([single_channel, single_channel, single_channel])
                    
                    return converted
                return color_space_transform
            
            transforms.append(A.Lambda(image=make_color_space_transform(color_space, channel), p=1.0))
            
        elif method == 'channel_select':
            # Keep only one RGB channel
            params = method_parameters.get('channel_select', {})
            channel = params.get('channel', 0)
            
            # Create closure with proper parameter capture
            def make_channel_select_transform(ch):
                def channel_select_transform(image, **kwargs):
                    if 0 <= ch < 3:
                        single_channel = image[:, :, ch]
                        # Replicate to 3 channels for compatibility
                        return cv2.merge([single_channel, single_channel, single_channel])
                    return image
                return channel_select_transform
            
            transforms.append(A.Lambda(image=make_channel_select_transform(channel), p=1.0))
            
        elif method == 'gaussian_noise':
            params = method_parameters.get('gaussian_noise', {})
            std = params.get('std', 0.01)
            transforms.append(A.GaussNoise(var_limit=(0, std * 255), p=1.0))
            
        elif method == 'gaussian_blur':
            params = method_parameters.get('gaussian_blur', {})
            kernel_size = params.get('kernel_size', 3)
            # Ensure kernel size is odd
            if kernel_size % 2 == 0:
                kernel_size += 1
            transforms.append(A.GaussianBlur(blur_limit=(kernel_size, kernel_size), p=1.0))
            
        elif method == 'cutout':
            params = method_parameters.get('cutout', {})
            num_holes = params.get('num_holes', 1)
            max_size = params.get('max_size', 16)
            transforms.append(A.CoarseDropout(
                max_holes=num_holes, 
                max_height=max_size, 
                max_width=max_size, 
                p=1.0
            ))
            
        elif method == 'elastic_transform':
            params = method_parameters.get('elastic_transform', {})
            alpha = params.get('alpha', 1.0)
            sigma = params.get('sigma', 50.0)
            transforms.append(A.ElasticTransform(alpha=alpha, sigma=sigma, p=1.0))
            
        elif method == 'grid_distortion':
            params = method_parameters.get('grid_distortion', {})
            num_steps = params.get('num_steps', 5)
            distort_limit = params.get('distort_limit', 0.3)
            transforms.append(A.GridDistortion(
                num_steps=num_steps, 
                distort_limit=distort_limit, 
                p=1.0
            ))
    
    # Return composed transform with bounding box and keypoint support
    # Keypoints are used for segmentation polygon transformation
    # Always include keypoint_params if we have any geometric transformations to ensure segmentation is transformed
    compose_kwargs = {
        'transforms': transforms,
        'bbox_params': A.BboxParams(
            format='coco',  # [x, y, width, height]
            label_fields=['class_labels'],
            # Keep all instances so bbox ↔ keypoint streams stay aligned for masks
            min_visibility=0.0,
        )
    }
    
    # Keypoint_params make Albumentations require `keypoints` in every __call__. We only have polygon
    # vertices when there is segmentation-derived flat_keypoints; bbox-only images must omit this or
    # Compose raises KeyError('keypoints') when keypoints are not passed in.
    if transforms and include_keypoint_params:
        compose_kwargs['keypoint_params'] = A.KeypointParams(
            format='xy',  # List of (x, y) tuples
            remove_invisible=False,  # Keep all keypoints even if partially out of bounds
        )

    return A.Compose(**compose_kwargs)


def load_image_from_path(image_path: str) -> np.ndarray:
    """Load image from file path and convert to RGB numpy array."""
    try:
        # Try to load with PIL first (better format support)
        pil_image = PILImage.open(image_path).convert('RGB')
        return np.array(pil_image)
    except Exception:
        # Fallback to OpenCV
        image = cv2.imread(image_path)
        if image is not None:
            return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        else:
            raise ValueError(f"Could not load image from {image_path}")


def save_image_to_path(image: np.ndarray, output_path: str) -> bool:
    """Save numpy array image to file path and create thumbnail."""
    try:
        # Convert RGB to PIL Image and save
        pil_image = PILImage.fromarray(image.astype(np.uint8))
        pil_image.save(output_path, quality=95, optimize=True)
        
        # Create thumbnail
        path_obj = Path(output_path)
        thumb_dir = path_obj.parent / "thumbnails"
        thumb_dir.mkdir(exist_ok=True)
        thumb_path = thumb_dir / path_obj.name
        
        # Create and save thumbnail (400x400 max)
        thumb_img = pil_image.copy()
        thumb_img.thumbnail((400, 400), PILImage.Resampling.LANCZOS)
        thumb_img.save(str(thumb_path), format='JPEG', quality=85, optimize=True)
        
        return True
    except Exception as e:
        logger.error(f"Error saving image to {output_path}: {e}")
        return False


def transform_bbox_with_augmentation(
    bbox: List[float], 
    image_width: int, 
    image_height: int, 
    augmentation_methods: List[str],
    method_parameters: Dict[str, Any],
    augmented_result: Dict
) -> Optional[List[float]]:
    """
    Transform bounding box coordinates based on the augmentation applied.
    Returns transformed bbox or None if bbox is no longer valid.
    """
    if not bbox or len(bbox) < 4:
        return None
    
    # The augmented_result contains transformed_bboxes if we passed bboxes to the transform
    # Otherwise, we need to compute manually based on augmentation type
    x, y, w, h = bbox[:4]
    
    for method in augmentation_methods:
        if method == 'flip_horizontal':
            # For horizontal flip: new_x = image_width - (x + w)
            x = image_width - (x + w)
        elif method == 'flip_vertical':
            # For vertical flip: new_y = image_height - (y + h)
            y = image_height - (y + h)
        elif method == 'scale':
            # For scaling, the bbox scales proportionally
            params = method_parameters.get('scale', {})
            # The actual scale factor varies, so we skip this for now
            # as it's handled by Albumentations
            pass
        elif method == 'rotation':
            # Rotation is complex and requires proper matrix transformation
            # Albumentations handles this internally
            pass
    
    # Ensure bbox is valid
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        return None
    
    return [x, y, w, h]


def transform_segmentation_with_augmentation(
    segmentation: List,
    image_width: int,
    image_height: int,
    augmentation_methods: List[str],
    method_parameters: Dict[str, Any]
) -> Optional[List]:
    """
    Transform segmentation polygon coordinates based on the augmentation applied.
    Returns transformed segmentation with integer coordinates or None if invalid.
    """
    if not segmentation:
        return None
    
    transformed_segmentation = []
    
    for polygon in segmentation:
        if not polygon or len(polygon) < 6:  # Need at least 3 points (6 values)
            continue
        
        transformed_polygon = []
        # Polygon is flat list: [x1, y1, x2, y2, x3, y3, ...]
        for i in range(0, len(polygon), 2):
            x = float(polygon[i])
            y = float(polygon[i + 1]) if i + 1 < len(polygon) else 0.0
            
            for method in augmentation_methods:
                if method == 'flip_horizontal':
                    x = image_width - x
                elif method == 'flip_vertical':
                    y = image_height - y
            
            # Convert to integer coordinates and clamp to valid bounds
            x_int = int(round(max(0, min(x, image_width - 1))))
            y_int = int(round(max(0, min(y, image_height - 1))))
            
            # Only add if coordinates are valid (non-negative and within bounds)
            if x_int >= 0 and y_int >= 0 and x_int < image_width and y_int < image_height:
                transformed_polygon.extend([x_int, y_int])
        
        if len(transformed_polygon) >= 6:
            transformed_segmentation.append(transformed_polygon)
    
    return transformed_segmentation if transformed_segmentation else None


@celery_app.task(base=AugmentationTask, bind=True, name='app.tasks.augmentation_tasks.create_augmented_dataset')
def create_augmented_dataset_task(self, task_id: int):
    """
    Celery task to create an augmented dataset with Albumentations.
    This task is executed by Celery worker with proper queuing and progress updates.
    """
    logger.info(f"Starting augmentation task {task_id} (Celery task {self.request.id})")
    db = SessionLocal()
    
    try:
        # Get the task record
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            raise Exception(f"Task {task_id} not found")
        
        # Check if task was cancelled before starting
        if task.status == 'cancelled' or task.status == 'stopped':
            logger.info(f"Task {task_id} was cancelled/stopped before starting")
            task.completed_at = datetime.utcnow()
            task.progress = 0.0
            db.commit()
            return {"status": "cancelled"}
        
        # Update task status to running
        task.status = 'running'
        task.started_at = datetime.utcnow()
        task.progress = 0.0
        task.task_metadata = {
            **(task.task_metadata or {}),
            "celery_task_id": self.request.id,
            "stage": "initializing"
        }
        db.commit()
        logger.info(f"Task {task_id}: Updated status to running")
        
        # Get the augmentation configuration
        augmentation = db.query(Augmentation).filter(Augmentation.task_id == task_id).first()
        if not augmentation:
            raise Exception(f"Augmentation configuration not found for task {task_id}")
        
        logger.info(f"Task {task_id}: Found augmentation config - factor: {augmentation.augmentation_factor}, methods: {augmentation.augmentation_methods}")
        
        # Update progress
        task.progress = 5.0
        task.task_metadata = {**(task.task_metadata or {}), "stage": "loading_datasets"}
        db.commit()
        
        # Check for cancellation
        db.refresh(task)
        if task.status in ['cancelled', 'stopped']:
            return {"status": "cancelled"}
        
        # Get source datasets
        source_datasets = db.query(Dataset).filter(
            Dataset.id.in_(augmentation.source_dataset_ids)
        ).all()
        
        if not source_datasets:
            raise Exception("No source datasets found")
        
        logger.info(f"Task {task_id}: Found {len(source_datasets)} source datasets")
        
        # Get target dataset
        target_dataset = db.query(Dataset).filter(
            Dataset.id == augmentation.target_dataset_id
        ).first()
        
        if not target_dataset:
            raise Exception("Target dataset not found")
        
        logger.info(f"Task {task_id}: Target dataset: {target_dataset.name}")

        # Ensure target dataset has a default image collection so tabbed UI can display
        # images while augmentation is still running.
        from app.services.dataset_collections_service import ensure_default_image_collection

        target_default_collection = (
            db.query(ImageCollection)
            .filter(
                ImageCollection.dataset_id == target_dataset.id,
                ImageCollection.is_default == True,
            )
            .first()
        )
        if not target_default_collection:
            target_default_collection = ensure_default_image_collection(
                db, target_dataset.id, description="Default image collection"
            )
            logger.info(
                f"Task {task_id}: Created default collection {target_default_collection.id} for dataset {target_dataset.id}"
            )
        
        # Update progress
        task.progress = 10.0
        task.task_metadata = {**(task.task_metadata or {}), "stage": "collecting_images"}
        db.commit()
        
        # Build per-dataset collection/annotation-file filters from task metadata.
        task_metadata = task.task_metadata or {}
        dataset_collection_filter, dataset_annotation_file_filter = _build_dataset_selection_filters(task_metadata)

        # Get all images from source datasets (filtered by selected collection
        # when provided).
        all_source_images = []
        for dataset in source_datasets:
            query = db.query(Image).filter(Image.dataset_id == dataset.id)
            selected_collection_id = dataset_collection_filter.get(dataset.id)
            if selected_collection_id is not None:
                query = query.filter(Image.collection_id == selected_collection_id)
            dataset_images = query.all()
            all_source_images.extend([(img, dataset.project_id) for img in dataset_images])
            if selected_collection_id is None:
                logger.info(
                    f"Task {task_id}: Found {len(dataset_images)} images in dataset {dataset.name}"
                )
            else:
                logger.info(
                    f"Task {task_id}: Found {len(dataset_images)} images in dataset {dataset.name} (collection {selected_collection_id})"
                )
        
        if not all_source_images:
            raise Exception("No images found in source datasets")
        
        total_images = len(all_source_images)
        augmentation_factor = int(augmentation.augmentation_factor)
        total_operations = total_images * augmentation_factor
        
        logger.info(f"Task {task_id}: Total images: {total_images}, factor: {augmentation_factor}, total operations: {total_operations}")
        
        # Update progress
        task.progress = 15.0
        task.task_metadata = {
            **(task.task_metadata or {}), 
            "stage": "processing",
            "total_images": total_images,
            "augmentation_factor": augmentation_factor
        }
        db.commit()
        
        # Create target directory
        target_dir = Path("projects") / str(target_dataset.project_id) / str(target_dataset.id) / "images"
        target_dir.mkdir(parents=True, exist_ok=True)
        
        # Create annotation file for the augmented dataset
        method_names = "_".join(augmentation.augmentation_methods[:3])
        annotation_file = AnnotationFile(
            id=str(uuid.uuid4()),
            dataset_id=target_dataset.id,
            name=f"augmented_{method_names}",
            format='COCO',
            type='classification',  # Will be updated based on source annotations
            file_size=0,
            annotation_count=0,
            image_count=0,
            category_count=0,
            is_processed=True,
            processing_status='completed',
            created_at=datetime.utcnow()
        )
        db.add(annotation_file)
        db.flush()  # Get the annotation file ID
        
        # Track categories for annotation classes
        category_counts = {}
        annotation_type = 'classification'  # Default, will detect from source
        
        # Build a mapping of class names to category_ids from source annotation files
        # This helps preserve category_id consistency across augmented datasets
        source_class_to_category_id = {}
        for source_dataset in source_datasets:
            source_ann_files_query = db.query(AnnotationFile).filter(
                AnnotationFile.dataset_id == source_dataset.id
            )
            selected_ann_file_id = dataset_annotation_file_filter.get(source_dataset.id)
            if selected_ann_file_id:
                source_ann_files_query = source_ann_files_query.filter(AnnotationFile.id == selected_ann_file_id)
            source_ann_files = source_ann_files_query.all()
            for ann_file in source_ann_files:
                source_classes = db.query(AnnotationClass).filter(
                    AnnotationClass.annotation_file_id == ann_file.id
                ).all()
                for ann_class in source_classes:
                    if ann_class.category_id is not None and ann_class.class_name:
                        # Use the first category_id we find for each class name
                        if ann_class.class_name not in source_class_to_category_id:
                            source_class_to_category_id[ann_class.class_name] = ann_class.category_id
        
        # Process images
        current_operation = 0
        processed_images = 0
        processed_annotations = 0
        errors = []
        
        for source_image, source_project_id in all_source_images:
            # Check for cancellation
            db.refresh(task)
            if task.status in ['cancelled', 'stopped']:
                logger.info(f"Task {task_id}: Cancelled during processing")
                task.status = 'cancelled'
                task.completed_at = datetime.utcnow()
                task.progress = min(processed_images / len(all_source_images) * 100, 100) if all_source_images else 0
                task.task_metadata = {
                    **(task.task_metadata or {}),
                    "stage": "cancelled",
                    "processed_images": processed_images,
                }
                db.commit()
                logger.info(f"Task {task_id}: Cancelled during processing, committed status to DB")
                return {"status": "cancelled", "processed": processed_images}
            
            try:
                # Resolve source image via shared helper (handles collection-aware
                # and nested image locations, URL-derived paths, and legacy layouts).
                source_path = resolve_dataset_image_path_from_models(
                    source_image,
                    dataset_id=source_image.dataset_id,
                    project_id=source_project_id,
                    collection_id=getattr(source_image, "collection_id", None),
                )

                if source_path is None:
                    logger.warning(f"Task {task_id}: Source image not found: {source_image.file_name}")
                    errors.append(f"Image not found: {source_image.file_name}")
                    current_operation += augmentation_factor
                    continue
                
                # Load the source image
                image_data = load_image_from_path(str(source_path))
                image_height, image_width = image_data.shape[:2]
                
                # Get source annotations for this image.
                # Respect selected annotation file per dataset to avoid mixing
                # labels from other annotation files in the same dataset.
                source_annotations_query = db.query(Annotation).filter(
                    Annotation.image_id == source_image.id
                )
                source_annotations_query = _apply_selected_annotation_file_filter(
                    source_annotations_query,
                    dataset_id=source_image.dataset_id,
                    dataset_annotation_file_filter=dataset_annotation_file_filter,
                )
                source_annotations = source_annotations_query.all()
                
                # Build per-image mappings from source annotation file's classes.
                # Keep these local so we don't overwrite the global map used in final class creation.
                image_class_to_category_id = {}
                image_category_id_to_class = {}
                if source_annotations:
                    # Get the annotation_file_id from the first annotation
                    source_ann_file_id = source_annotations[0].annotation_file_id
                    if source_ann_file_id:
                        source_classes = db.query(AnnotationClass).filter(
                            AnnotationClass.annotation_file_id == source_ann_file_id
                        ).all()
                        for ann_class in source_classes:
                            if ann_class.category_id is not None:
                                if ann_class.class_name:
                                    image_class_to_category_id[ann_class.class_name] = ann_class.category_id
                                    image_category_id_to_class[ann_class.category_id] = ann_class.class_name

                def normalize_class_name(category_name, category_id):
                    """Resolve synthetic names like category_0/unknown back to real class names by category_id."""
                    if category_id is not None:
                        mapped = image_category_id_to_class.get(category_id)
                        if mapped:
                            if (
                                not category_name
                                or category_name == 'unknown'
                                or (isinstance(category_name, str) and category_name.startswith('category_'))
                            ):
                                return mapped
                    return category_name or 'unknown'
                
                # Prepare bboxes, labels, and keypoints (for segmentation) for Albumentations
                bboxes = []
                class_labels = []
                keypoints = []  # List of lists of (x, y) tuples for each annotation's segmentation
                annotation_data_list = []
                classification_annotations = []  # Annotations without bboxes (classification)
                
                for ann in source_annotations:
                    pixel_bbox = annotation_bbox_pixel_xywh(
                        ann,
                        img_width=image_width,
                        img_height=image_height,
                    )
                    if pixel_bbox and len(pixel_bbox) >= 4:
                        # Albumentations COCO format: [x, y, width, height]
                        x, y, w, h = pixel_bbox[:4]
                        # Clamp bbox to image bounds
                        x = max(0, min(x, image_width))
                        y = max(0, min(y, image_height))
                        w = min(w, image_width - x)
                        h = min(h, image_height - y)
                        
                        if w > 0 and h > 0:
                            bboxes.append([x, y, w, h])
                            resolved_category = normalize_class_name(ann.category, ann.category_id)
                            class_labels.append(resolved_category)
                            
                            # Get category_id from source annotation/map without extra DB queries
                            category_id = ann.category_id
                            if category_id is None and resolved_category:
                                category_id = image_class_to_category_id.get(resolved_category)
                            
                            # Convert segmentation to keypoint format for Albumentations (use same normalization as COCO import)
                            norm_seg, has_polygon_masks, has_rle_mask = _segmentation_mask_flags(
                                ann.segmentation, image_width, image_height
                            )
                            ann_keypoints = []
                            keypoint_polygon_vertex_counts: List[int] = []
                            if has_polygon_masks and isinstance(norm_seg, list):
                                for polygon in norm_seg:
                                    if polygon and isinstance(polygon, list) and len(polygon) >= 6:
                                        polygon_keypoints = []
                                        for i in range(0, len(polygon), 2):
                                            if i + 1 < len(polygon):
                                                px = float(polygon[i])
                                                py = float(polygon[i + 1])
                                                px = max(0.0, min(px, float(image_width - 1)))
                                                py = max(0.0, min(py, float(image_height - 1)))
                                                polygon_keypoints.append((px, py))
                                        if len(polygon_keypoints) >= 3:
                                            keypoint_polygon_vertex_counts.append(len(polygon_keypoints))
                                            ann_keypoints.extend(polygon_keypoints)
                            
                            annotation_data_list.append({
                                'category': resolved_category,
                                'segmentation': norm_seg if has_polygon_masks else _parse_annotation_segmentation(ann.segmentation),
                                'area': ann.area,
                                'category_id': category_id,
                                'keypoints': ann_keypoints,
                                'keypoint_polygon_vertex_counts': keypoint_polygon_vertex_counts,
                                'has_polygon_masks': has_polygon_masks,
                                'has_rle_mask': has_rle_mask,
                            })
                            keypoints.append(ann_keypoints)  # Add to keypoints list for Albumentations
                    else:
                        # Classification annotation (no bbox) - store for copying
                        classification_annotations.append(ann)

                # Bbox-only images append one [] per annotation, so bool(keypoints) is
                # True even with no polygon vertices — only enable keypoint_params when
                # at least one annotation has real mask vertices.
                has_polygon_keypoints = any(kp for kp in keypoints)
                
                # Create augmented versions
                # Compose is randomized per call, so it can be reused safely and avoids
                # rebuilding the full transform graph for every augmentation iteration.
                transform = create_albumentations_transform(
                    augmentation.augmentation_methods,
                    augmentation.method_parameters or {},
                    include_keypoint_params=has_polygon_keypoints,
                )
                for i in range(augmentation_factor):
                    # Check for cancellation
                    db.refresh(task)
                    if task.status in ['cancelled', 'stopped']:
                        return {"status": "cancelled", "processed": processed_images}
                    
                    try:
                        # Flatten polygon vertices for Albumentations (empty for bbox-only / no valid polygons)
                        flat_keypoints: List[Tuple[float, float]] = []
                        for kp_list in keypoints:
                            flat_keypoints.extend(kp_list)

                        # Apply augmentation with bboxes and keypoints (for segmentation)
                        if bboxes and augmentation.transform_annotations:
                            
                            # Prepare transform arguments
                            transform_args = {
                                'image': image_data,
                                'bboxes': bboxes,
                                'class_labels': class_labels
                            }
                            
                            # When keypoint_params is configured, Albumentations requires keypoints on every call.
                            if has_polygon_keypoints:
                                transform_args['keypoints'] = flat_keypoints
                            
                            augmented = transform(**transform_args)
                            transformed_bboxes = augmented['bboxes']
                            transformed_labels = augmented['class_labels']
                            # Get transformed keypoints if available, otherwise use original
                            transformed_keypoints = augmented.get('keypoints', flat_keypoints if flat_keypoints else [])
                            
                            # Log keypoint transformation for debugging
                            if flat_keypoints and transformed_keypoints:
                                logger.debug(f"Keypoint transformation: {len(flat_keypoints)} -> {len(transformed_keypoints)} keypoints")
                                if len(transformed_keypoints) > 0:
                                    sample_kp = transformed_keypoints[0]
                                    logger.debug(f"Sample transformed keypoint format: {type(sample_kp)}, value: {sample_kp}")
                        else:
                            # Keep call signature compatible with Compose configured
                            # with bbox_params(label_fields=['class_labels']).
                            # When a source image has no bbox annotations (e.g.
                            # classification-only), Albumentations still validates
                            # label_fields and raises:
                            # "Your 'label_fields' are not valid..."
                            # unless we pass empty bboxes + class_labels.
                            augmented = transform(
                                image=image_data,
                                bboxes=[],
                                class_labels=[],
                            )
                            transformed_bboxes = []
                            transformed_labels = []
                            transformed_keypoints = []
                        
                        augmented_image = augmented['image']
                        aug_height, aug_width = augmented_image.shape[:2]
                        
                        # Generate output filename (include source dataset_id to prevent collisions
                        # when multiple source datasets have files with the same name)
                        method_suffix = "_".join(augmentation.augmentation_methods[:2])
                        file_name = generate_safe_output_filename(
                            source_image.file_name,
                            source_image.dataset_id,
                            augmentation_index=i,
                            method_suffix=method_suffix
                        )
                        
                        # Save augmented image
                        output_path = target_dir / file_name
                        success = save_image_to_path(augmented_image, str(output_path))
                        
                        if not success:
                            errors.append(f"Failed to save: {file_name}")
                            continue
                        
                        # Get file size
                        file_size = output_path.stat().st_size if output_path.exists() else 0
                        
                        # Create augmented image record
                        relative_url = f"/static/projects/{target_dataset.project_id}/{target_dataset.id}/images/{file_name}"
                        thumbnail_relative_url = f"/static/projects/{target_dataset.project_id}/{target_dataset.id}/images/thumbnails/{file_name}"
                        
                        augmented_image_record = Image(
                            dataset_id=target_dataset.id,
                            collection_id=target_default_collection.id,
                            file_name=file_name,
                            file_size=file_size,
                            width=aug_width,
                            height=aug_height,
                            url=relative_url,
                            thumbnail_url=thumbnail_relative_url,
                            uploaded_at=datetime.utcnow()
                        )
                        db.add(augmented_image_record)
                        db.flush()  # Get the image ID
                        
                        # Create AnnotationFileImage entry
                        annotation_file_image = AnnotationFileImage(
                            annotation_file_id=annotation_file.id,
                            file_name=file_name,
                            dataset_image_id=augmented_image_record.id,
                            width=aug_width,
                            height=aug_height,
                            created_at=datetime.utcnow()
                        )
                        db.add(annotation_file_image)
                        
                        # Create annotations for augmented image
                        if augmentation.transform_annotations and transformed_bboxes:
                            # Reconstruct keypoints per annotation from transformed flat list
                            keypoint_idx = 0
                            for bbox_idx, (bbox, label) in enumerate(zip(transformed_bboxes, transformed_labels)):
                                if bbox_idx < len(annotation_data_list):
                                    ann_data = annotation_data_list[bbox_idx]
                                    expect_masks = bool(
                                        ann_data.get("has_polygon_masks") or ann_data.get("has_rle_mask")
                                    )
                                    
                                    # Transform segmentation using transformed keypoints from Albumentations
                                    transformed_seg = None
                                    if ann_data.get('keypoints') and len(ann_data['keypoints']) > 0:
                                        # Get the transformed keypoints for this annotation
                                        num_keypoints = len(ann_data['keypoints'])
                                        if keypoint_idx + num_keypoints <= len(transformed_keypoints):
                                            ann_transformed_kp = transformed_keypoints[keypoint_idx:keypoint_idx + num_keypoints]
                                            keypoint_idx += num_keypoints
                                            
                                            # Rebuild COCO segmentation: split keypoints back into polygon rings
                                            if ann_transformed_kp:
                                                vertex_counts = ann_data.get('keypoint_polygon_vertex_counts') or []
                                                if (
                                                    not vertex_counts
                                                    or sum(vertex_counts) != len(ann_transformed_kp)
                                                ):
                                                    vertex_counts = [len(ann_transformed_kp)]
                                                polygons_out: List[List[int]] = []
                                                offset_poly = 0
                                                total_outside = 0
                                                for ring_idx, cnt in enumerate(vertex_counts):
                                                    if cnt < 1:
                                                        continue
                                                    chunk = ann_transformed_kp[offset_poly : offset_poly + cnt]
                                                    offset_poly += cnt
                                                    flat_seg: List[int] = []
                                                    ring_outside = 0
                                                    for kp in chunk:
                                                        if isinstance(kp, (list, tuple, np.ndarray)):
                                                            arr = np.asarray(kp).reshape(-1)
                                                            if arr.size < 2:
                                                                continue
                                                            kx = float(arr[0].item())
                                                            ky = float(arr[1].item())
                                                        else:
                                                            logger.warning(f"Invalid keypoint format: {kp}")
                                                            continue
                                                        if (
                                                            kx < -0.5
                                                            or kx > aug_width + 0.5
                                                            or ky < -0.5
                                                            or ky > aug_height + 0.5
                                                        ):
                                                            ring_outside += 1
                                                            total_outside += 1
                                                        kx = max(0.0, min(kx, float(max(0, aug_width - 1))))
                                                        ky = max(0.0, min(ky, float(max(0, aug_height - 1))))
                                                        if not (
                                                            np.isnan(kx)
                                                            or np.isnan(ky)
                                                            or np.isinf(kx)
                                                            or np.isinf(ky)
                                                        ):
                                                            kx_int = int(round(kx))
                                                            ky_int = int(round(ky))
                                                            if (
                                                                0 <= kx_int < aug_width
                                                                and 0 <= ky_int < aug_height
                                                            ):
                                                                flat_seg.extend([kx_int, ky_int])
                                                        else:
                                                            logger.warning(
                                                                f"Invalid keypoint value (NaN/Inf): ({kx}, {ky})"
                                                            )
                                                    validated_seg: List[int] = []
                                                    for coord_idx in range(0, len(flat_seg), 2):
                                                        if coord_idx + 1 < len(flat_seg):
                                                            x_int = int(flat_seg[coord_idx])
                                                            y_int = int(flat_seg[coord_idx + 1])
                                                            if (
                                                                x_int >= 0
                                                                and y_int >= 0
                                                                and x_int < aug_width
                                                                and y_int < aug_height
                                                            ):
                                                                validated_seg.extend([x_int, y_int])
                                                    if len(validated_seg) >= 6 and len(validated_seg) // 2 >= 3:
                                                        polygons_out.append(validated_seg)
                                                    elif ring_outside:
                                                        logger.debug(
                                                            f"Annotation {bbox_idx} ring {ring_idx}: "
                                                            f"insufficient in-bounds points after geometry aug"
                                                        )
                                                if offset_poly != len(ann_transformed_kp):
                                                    logger.warning(
                                                        f"Keypoint ring sizes mismatch ann={bbox_idx}: "
                                                        f"got {len(ann_transformed_kp)} keypoints, "
                                                        f"consumed {offset_poly} via counts {vertex_counts}"
                                                    )
                                                if polygons_out:
                                                    transformed_seg = _clip_segmentation_polygons(
                                                        polygons_out, aug_width, aug_height
                                                    )
                                                    logger.debug(
                                                        f"Transformed segmentation ann={bbox_idx}: "
                                                        f"{len(polygons_out)} polygon(s), "
                                                        f"{total_outside} verts were slightly OOB before clamp"
                                                    )
                                        else:
                                            logger.warning(f"Not enough transformed keypoints for annotation {bbox_idx}: need {num_keypoints}, have {len(transformed_keypoints) - keypoint_idx}")
                                    
                                    # If segmentation transformation failed, try flip-only fallback (rotation/scale/elastic need keypoints path)
                                    if (
                                        not transformed_seg
                                        and ann_data.get("has_polygon_masks")
                                        and isinstance(ann_data.get("segmentation"), list)
                                    ):
                                        logger.warning(
                                            f"Failed to transform segmentation using keypoints for annotation {bbox_idx}, "
                                            f"using flip-only fallback"
                                        )
                                        transformed_seg = transform_segmentation_with_augmentation(
                                            ann_data['segmentation'],
                                            aug_width,
                                            aug_height,
                                            augmentation.augmentation_methods,
                                            augmentation.method_parameters or {}
                                        )
                                    
                                    # Final validation: ensure transformed_seg has no negative coordinates
                                    # This is CRITICAL - we must NEVER save negative coordinates
                                    if transformed_seg:
                                        # Validate all coordinates in transformed_seg
                                        validated_seg_final = []
                                        for polygon in transformed_seg:
                                            if isinstance(polygon, list) and len(polygon) >= 6:
                                                validated_polygon = []
                                                has_invalid = False
                                                
                                                for coord_idx in range(0, len(polygon), 2):
                                                    if coord_idx + 1 < len(polygon):
                                                        x = float(polygon[coord_idx])
                                                        y = float(polygon[coord_idx + 1])
                                                        
                                                        # Convert to integer coordinates
                                                        x_int = int(round(x))
                                                        y_int = int(round(y))
                                                        
                                                        # STRICT validation - reject if ANY coordinate is invalid
                                                        if (x_int < 0 or y_int < 0 or 
                                                            x_int >= aug_width or y_int >= aug_height or
                                                            np.isnan(x_int) or np.isnan(y_int) or 
                                                            np.isinf(x_int) or np.isinf(y_int)):
                                                            has_invalid = True
                                                            logger.warning(f"Invalid coordinate in annotation {bbox_idx} for {file_name}: ({x_int}, {y_int}), image size: {aug_width}x{aug_height}")
                                                            break
                                                        
                                                        validated_polygon.extend([x_int, y_int])
                                                
                                                # Only add polygon if it has no invalid coordinates and enough points
                                                if not has_invalid and len(validated_polygon) >= 6:
                                                    validated_seg_final.append(validated_polygon)
                                                else:
                                                    if has_invalid:
                                                        logger.warning(f"Rejecting polygon in annotation {bbox_idx} for {file_name}: contains invalid coordinates")
                                        
                                        if validated_seg_final:
                                            transformed_seg = validated_seg_final
                                            # Final double-check: verify NO negative coordinates in final result
                                            for poly in validated_seg_final:
                                                for i in range(0, len(poly), 2):
                                                    if i + 1 < len(poly):
                                                        if poly[i] < 0 or poly[i + 1] < 0:
                                                            logger.error(f"CRITICAL: Negative coordinate found in validated_seg_final! This should never happen. Value: ({poly[i]}, {poly[i+1]})")
                                                            transformed_seg = None
                                                            break
                                                if transformed_seg is None:
                                                    break
                                        else:
                                            logger.warning(f"Rejecting annotation {bbox_idx} for {file_name}: all polygons invalid after validation")
                                            transformed_seg = None
                                    
                                    # Log if segmentation is still None
                                    if not transformed_seg:
                                        logger.warning(f"No segmentation for annotation {bbox_idx} (category: {label})")
                                    
                                    # Calculate new area and convert numpy types to Python floats
                                    new_area = float(bbox[2] * bbox[3]) if len(bbox) >= 4 else ann_data.get('area')
                                    
                                    # Convert bbox values to Python floats (Albumentations returns numpy types)
                                    bbox_list = [float(v) for v in bbox]
                                    
                                    # Get category_id - use from ann_data, or look up from target annotation file's AnnotationClass
                                    category_id = ann_data.get('category_id')
                                    if category_id is None and label:
                                        # Look up category_id from target annotation file's AnnotationClass
                                        ann_class = db.query(AnnotationClass).filter(
                                            AnnotationClass.annotation_file_id == annotation_file.id,
                                            AnnotationClass.class_name == label
                                        ).first()
                                        if ann_class and ann_class.category_id is not None:
                                            category_id = ann_class.category_id
                                        else:
                                            # If still None, assign a category_id based on class name order
                                            # This ensures we always have a category_id
                                            all_classes = db.query(AnnotationClass).filter(
                                                AnnotationClass.annotation_file_id == annotation_file.id
                                            ).order_by(AnnotationClass.id).all()
                                            class_names = [c.class_name for c in all_classes]
                                            if label in class_names:
                                                category_id = class_names.index(label) + 1
                                            else:
                                                # New class, assign next available ID
                                                max_category_id = max([c.category_id for c in all_classes if c.category_id is not None], default=0)
                                                category_id = max_category_id + 1
                                    
                                    # FINAL CHECK: Verify no negative coordinates and ensure all are integers before saving
                                    # This is the last line of defense - reject if ANY coordinate is negative
                                    if transformed_seg:
                                        final_seg = []
                                        for polygon in transformed_seg:
                                            if isinstance(polygon, list):
                                                final_polygon = []
                                                has_invalid = False
                                                for coord_idx in range(0, len(polygon), 2):
                                                    if coord_idx + 1 < len(polygon):
                                                        x = polygon[coord_idx]
                                                        y = polygon[coord_idx + 1]
                                                        
                                                        # Convert to integer if not already
                                                        x_int = int(round(float(x))) if not isinstance(x, int) else int(x)
                                                        y_int = int(round(float(y))) if not isinstance(y, int) else int(y)
                                                        
                                                        # Final validation: no negatives, within bounds
                                                        if x_int < 0 or y_int < 0 or x_int >= aug_width or y_int >= aug_height:
                                                            logger.error(f"ABORTING: Found invalid coordinate ({x_int}, {y_int}) in annotation {bbox_idx} for {file_name} - rejecting entire annotation")
                                                            has_invalid = True
                                                            break
                                                        
                                                        final_polygon.extend([x_int, y_int])
                                                
                                                if not has_invalid and len(final_polygon) >= 6:
                                                    final_seg.append(final_polygon)
                                                else:
                                                    if has_invalid:
                                                        transformed_seg = None
                                                        break
                                        
                                        if transformed_seg is not None:
                                            transformed_seg = final_seg if final_seg else None
                                    
                                    if transformed_seg:
                                        transformed_seg = _clip_segmentation_polygons(
                                            transformed_seg, aug_width, aug_height
                                        )

                                    # Only create annotation if we have valid segmentation (or true bbox-only source)
                                    if transformed_seg or (not expect_masks and bbox_list):
                                        # One more safety check right before database save - ensure all integers and no negatives
                                        if transformed_seg:
                                            for polygon in transformed_seg:
                                                if isinstance(polygon, list):
                                                    for coord_idx in range(0, len(polygon), 2):
                                                        if coord_idx + 1 < len(polygon):
                                                            x = polygon[coord_idx]
                                                            y = polygon[coord_idx + 1]
                                                            # Ensure integer and validate
                                                            x_int = int(x) if isinstance(x, (int, float)) else x
                                                            y_int = int(y) if isinstance(y, (int, float)) else y
                                                            if x_int < 0 or y_int < 0 or x_int >= aug_width or y_int >= aug_height:
                                                                logger.error(f"CRITICAL ERROR: Invalid coordinate detected right before DB save! Rejecting annotation {bbox_idx}: ({x_int}, {y_int})")
                                                                transformed_seg = None
                                                                break
                                                        if transformed_seg is None:
                                                            break
                                                if transformed_seg is None:
                                                    break
                                        
                                        if transformed_seg or (not expect_masks and bbox_list):
                                            new_annotation = Annotation(
                                                annotation_file_id=annotation_file.id,
                                                image_id=augmented_image_record.id,
                                                dataset_id=target_dataset.id,
                                                category=label,
                                                category_id=category_id,  # Use resolved category_id
                                                bbox=bbox_list,
                                                bbox_x=float(bbox[0] / aug_width) if aug_width > 0 else 0,
                                                bbox_y=float(bbox[1] / aug_height) if aug_height > 0 else 0,
                                                bbox_width=float(bbox[2] / aug_width) if aug_width > 0 else 0,
                                                bbox_height=float(bbox[3] / aug_height) if aug_height > 0 else 0,
                                                segmentation=transformed_seg,
                                                area=float(new_area) if new_area is not None else None,
                                                uploaded_at=datetime.utcnow()
                                            )
                                            db.add(new_annotation)
                                            processed_annotations += 1
                                            
                                            # Log annotation creation for debugging
                                            if transformed_seg:
                                                logger.debug(f"Created annotation for {file_name}: category={label}, segmentation_points={sum(len(p) for p in transformed_seg) if isinstance(transformed_seg, list) else 0}")
                                            else:
                                                logger.debug(f"Created annotation for {file_name}: category={label}, no segmentation")
                                            
                                            # Track category counts and detect annotation type (match annotation_db / UI)
                                            annotation_type = 'segmentation' if transformed_seg else 'Segmentation (bbox)'
                                            if ann_data.get('has_polygon_masks') or ann_data.get('has_rle_mask'):
                                                annotation_type = 'segmentation'
                                            category_counts[label] = category_counts.get(label, 0) + 1
                                        else:
                                            logger.warning(f"Skipping annotation {bbox_idx} for {file_name}: failed final validation check")
                                    else:
                                        if ann_data.get("has_rle_mask"):
                                            logger.warning(
                                                f"Skipping annotation {bbox_idx} for {file_name}: "
                                                f"COCO RLE segmentation is not supported for geometry augmentation in this worker yet."
                                            )
                                        elif expect_masks:
                                            logger.warning(
                                                f"Skipping annotation {bbox_idx} for {file_name}: "
                                                f"polygon masks could not be transformed — not saving a bbox-only substitute."
                                            )
                                        else:
                                            logger.warning(
                                                f"Skipping annotation {bbox_idx} for {file_name}: no valid segmentation after transformation"
                                            )
                        
                        # Copy classification annotations (no bbox) - they apply to the whole image
                        if classification_annotations:
                            for ann in classification_annotations:
                                # Get category_id - use from annotation, or look up from target annotation file's AnnotationClass
                                category_id = ann.category_id
                                resolved_category = normalize_class_name(ann.category, ann.category_id)
                                if category_id is None and resolved_category:
                                    # Look up category_id from target annotation file's AnnotationClass
                                    ann_class = db.query(AnnotationClass).filter(
                                        AnnotationClass.annotation_file_id == annotation_file.id,
                                        AnnotationClass.class_name == resolved_category
                                    ).first()
                                    if ann_class and ann_class.category_id is not None:
                                        category_id = ann_class.category_id
                                    else:
                                        # If still None, assign a category_id based on class name order
                                        all_classes = db.query(AnnotationClass).filter(
                                            AnnotationClass.annotation_file_id == annotation_file.id
                                        ).order_by(AnnotationClass.id).all()
                                        class_names = [c.class_name for c in all_classes]
                                        if resolved_category in class_names:
                                            category_id = class_names.index(resolved_category) + 1
                                        else:
                                            # New class, assign next available ID
                                            max_category_id = max([c.category_id for c in all_classes if c.category_id is not None], default=0)
                                            category_id = max_category_id + 1
                                
                                new_annotation = Annotation(
                                    annotation_file_id=annotation_file.id,
                                    image_id=augmented_image_record.id,
                                    dataset_id=target_dataset.id,
                                    category=resolved_category,
                                    category_id=category_id,  # Use resolved category_id
                                    bbox=None,
                                    bbox_x=None,
                                    bbox_y=None,
                                    bbox_width=None,
                                    bbox_height=None,
                                    segmentation=None,
                                    area=None,
                                    uploaded_at=datetime.utcnow()
                                )
                                db.add(new_annotation)
                                processed_annotations += 1
                                
                                # Track category counts
                                category_counts[resolved_category] = category_counts.get(resolved_category, 0) + 1
                        
                        # Copy annotations without transformation if disabled
                        if not augmentation.transform_annotations and source_annotations:
                            for ann in source_annotations:
                                # Get category_id - use from annotation, or look up from target annotation file's AnnotationClass
                                category_id = ann.category_id
                                resolved_category = normalize_class_name(ann.category, ann.category_id)
                                if category_id is None and resolved_category:
                                    # Look up category_id from target annotation file's AnnotationClass
                                    ann_class = db.query(AnnotationClass).filter(
                                        AnnotationClass.annotation_file_id == annotation_file.id,
                                        AnnotationClass.class_name == resolved_category
                                    ).first()
                                    if ann_class and ann_class.category_id is not None:
                                        category_id = ann_class.category_id
                                    else:
                                        # If still None, assign a category_id based on class name order
                                        all_classes = db.query(AnnotationClass).filter(
                                            AnnotationClass.annotation_file_id == annotation_file.id
                                        ).order_by(AnnotationClass.id).all()
                                        class_names = [c.class_name for c in all_classes]
                                        if resolved_category in class_names:
                                            category_id = class_names.index(resolved_category) + 1
                                        else:
                                            # New class, assign next available ID
                                            max_category_id = max([c.category_id for c in all_classes if c.category_id is not None], default=0)
                                            category_id = max_category_id + 1
                                
                                new_annotation = Annotation(
                                    annotation_file_id=annotation_file.id,
                                    image_id=augmented_image_record.id,
                                    dataset_id=target_dataset.id,
                                    category=resolved_category,
                                    category_id=category_id,  # Use resolved category_id
                                    bbox=ann.bbox,
                                    bbox_x=ann.bbox_x,
                                    bbox_y=ann.bbox_y,
                                    bbox_width=ann.bbox_width,
                                    bbox_height=ann.bbox_height,
                                    segmentation=ann.segmentation,
                                    area=ann.area,
                                    uploaded_at=datetime.utcnow()
                                )
                                db.add(new_annotation)
                                processed_annotations += 1
                                
                                # Track category counts and detect annotation type
                                if ann.bbox:
                                    annotation_type = 'segmentation' if ann.segmentation else 'Segmentation (bbox)'
                                category_counts[resolved_category] = category_counts.get(resolved_category, 0) + 1
                        
                        processed_images += 1
                        current_operation += 1
                        
                    except Exception as e:
                        logger.error(f"Task {task_id}: Error processing augmentation {i} for {source_image.file_name}: {e}")
                        errors.append(f"Augmentation {i} failed for {source_image.file_name}: {str(e)}")
                        current_operation += 1
                
                # Update progress periodically
                if current_operation % 10 == 0:
                    progress = 15.0 + (current_operation / total_operations) * 75.0
                    task.progress = min(progress, 90.0)
                    task.task_metadata = {
                        **(task.task_metadata or {}),
                        "stage": "processing",
                        "processed_images": processed_images,
                        "processed_annotations": processed_annotations,
                        "current_operation": current_operation,
                        "total_operations": total_operations,
                        "errors_count": len(errors)
                    }
                    db.commit()
                    
                    # Update Celery task state
                    self.update_state(
                        state='PROGRESS',
                        meta={
                            'progress': task.progress,
                            'processed': processed_images,
                            'total': total_operations
                        }
                    )
                    
            except Exception as e:
                logger.error(f"Task {task_id}: Error processing image {source_image.file_name}: {e}")
                errors.append(f"Failed to process {source_image.file_name}: {str(e)}")
                current_operation += augmentation_factor
        
        # Final check for cancellation
        db.refresh(task)
        if task.status in ['cancelled', 'stopped']:
            return {"status": "cancelled", "processed": processed_images}
        
        # Update dataset counts
        task.progress = 95.0
        task.task_metadata = {**(task.task_metadata or {}), "stage": "finalizing"}
        db.commit()
        
        # Refresh dataset to ensure it's in a clean state for count query
        db.refresh(target_dataset)
        
        # Query and update image count - now that all images have been committed
        target_dataset.image_count = db.query(Image).filter(
            Image.dataset_id == target_dataset.id
        ).count()
        logger.info(f"Task {task_id}: Updated dataset {target_dataset.id} image_count to {target_dataset.image_count}")
        
        # Update image annotation counts in bulk (avoid per-image count queries)
        annotation_counts = dict(
            db.query(Annotation.image_id, func.count(Annotation.id))
            .filter(Annotation.dataset_id == target_dataset.id)
            .group_by(Annotation.image_id)
            .all()
        )
        for img in db.query(Image).filter(Image.dataset_id == target_dataset.id).all():
            img.annotations_count = int(annotation_counts.get(img.id, 0))
        
        # Update annotation file statistics
        annotation_file.annotation_count = processed_annotations
        annotation_file.image_count = processed_images
        annotation_file.category_count = len(category_counts)
        annotation_file.type = annotation_type
        annotation_file.statistics = {
            "category_distribution": category_counts
        }
        
        # Create AnnotationClass entries for each category with proper category_id
        # Try to preserve category_id from source classes, otherwise assign sequentially
        category_id_counter = 1
        used_category_ids = set()
        
        for category_name, count in category_counts.items():
            # Check if AnnotationClass already exists (might have been created earlier)
            existing_class = db.query(AnnotationClass).filter(
                AnnotationClass.annotation_file_id == annotation_file.id,
                AnnotationClass.class_name == category_name
            ).first()
            
            if existing_class:
                # Update count if class already exists
                existing_class.count = count
                # Ensure it has a category_id
                if existing_class.category_id is None:
                    # Try to use source category_id if available
                    category_id = source_class_to_category_id.get(category_name)
                    if category_id is None or category_id in used_category_ids:
                        # Assign next available ID
                        while category_id_counter in used_category_ids:
                            category_id_counter += 1
                        category_id = category_id_counter
                        category_id_counter += 1
                    existing_class.category_id = category_id
                    used_category_ids.add(category_id)
            else:
                # Try to use source category_id if available
                category_id = source_class_to_category_id.get(category_name)
                if category_id is None or category_id in used_category_ids:
                    # Assign next available ID
                    while category_id_counter in used_category_ids:
                        category_id_counter += 1
                    category_id = category_id_counter
                    category_id_counter += 1
                used_category_ids.add(category_id)
                
                # Create new AnnotationClass with category_id
                ann_class = AnnotationClass(
                    annotation_file_id=annotation_file.id,
                    class_name=category_name,
                    category_id=category_id,
                    count=count,
                    created_at=datetime.utcnow()
                )
                db.add(ann_class)
        
        db.commit()
        
        # Select a random image to be the dataset logo
        try:
            import random
            # Refresh the dataset to get the latest state
            db.refresh(target_dataset)
            
            all_dataset_images = db.query(Image).filter(
                Image.dataset_id == target_dataset.id
            ).all()
            
            logger.info(f"Task {task_id}: Found {len(all_dataset_images)} images for logo selection")
            
            if all_dataset_images:
                random_image = random.choice(all_dataset_images)
                logger.info(f"Task {task_id}: Selected image {random_image.file_name}, URL: {random_image.url}")
                
                target_dataset.logo_url = random_image.url
                target_dataset.thumbnailUrl = random_image.thumbnail_url or random_image.url
                db.commit()
                
                # Verify it was set
                db.refresh(target_dataset)
                logger.info(f"Task {task_id}: Set dataset logo_url={target_dataset.logo_url}, thumbnailUrl={target_dataset.thumbnailUrl}")
            else:
                logger.warning(f"Task {task_id}: No images found to set as logo")
        except Exception as e:
            logger.error(f"Task {task_id}: Failed to set dataset logo: {e}", exc_info=True)
            # Don't fail the task if logo setting fails
        
        # If nothing was created, mark as failed instead of incorrectly reporting success.
        if processed_images == 0 and len(errors) > 0:
            task.status = 'failed'
            task.progress = 100.0
            task.completed_at = datetime.utcnow()
            first_error = errors[0] if errors else 'Augmentation produced no images'
            task.error_message = f"Augmentation produced no images. First error: {first_error}"
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "failed",
                "processed_images": processed_images,
                "processed_annotations": processed_annotations,
                "errors": errors[:10],
                "errors_count": len(errors),
            }
            db.commit()
            logger.error(
                f"Task {task_id}: Failed - produced 0 images with {len(errors)} errors. First error: {first_error}"
            )
            return {
                "status": "failed",
                "processed_images": processed_images,
                "processed_annotations": processed_annotations,
                "errors_count": len(errors),
            }

        # Complete the task
        task.status = 'completed'
        task.progress = 100.0
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **(task.task_metadata or {}),
            "stage": "completed",
            "processed_images": processed_images,
            "processed_annotations": processed_annotations,
            "errors": errors[:10] if errors else [],  # Keep first 10 errors
            "errors_count": len(errors)
        }
        db.commit()
        
        # Final verification that dataset has images
        final_image_count = db.query(Image).filter(Image.dataset_id == target_dataset.id).count()
        logger.info(f"Task {task_id}: Completed successfully. Processed {processed_images} images, {processed_annotations} annotations, {len(errors)} errors. Final DB image count: {final_image_count}")
        
        return {
            "status": "completed",
            "processed_images": processed_images,
            "processed_annotations": processed_annotations,
            "errors_count": len(errors)
        }
        
    except Exception as e:
        logger.error(f"Task {task_id}: Fatal error: {e}", exc_info=True)
        
        # Update task status
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if task and task.status not in ['cancelled', 'stopped']:
            task.status = 'failed'
            task.completed_at = datetime.utcnow()
            task.error_message = str(e)
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "failed",
                "error": str(e)
            }
            db.commit()
        
        raise
        
    finally:
        db.close()
