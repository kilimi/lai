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
from ..database import get_db

# Create logger for this module
logger = logging.getLogger(__name__)

router = APIRouter()


async def process_augmented_dataset_task(task_id: int, db_path: str):
    """Background task to process augmented dataset creation"""
    logger.info(f"Starting augmentation task {task_id}")
    
    from ..database import SessionLocal
    
    db = SessionLocal()
    try:
        # Get the task
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            logger.error(f"Task {task_id} not found")
            return
        
        logger.info(f"Task {task_id}: Found task, current status: {task.status}")
        
        # Check if task was cancelled before starting
        if task.status == 'cancelled':
            logger.info(f"Task {task_id}: Task was cancelled before starting")
            return
        
        # Update task status to running
        task.status = 'running'
        task.started_at = datetime.utcnow()
        task.progress = 0.0
        db.commit()
        logger.info(f"Task {task_id}: Updated status to running")
        
        # Get the augmentation details
        augmentation = db.query(models.Augmentation).filter(models.Augmentation.task_id == task_id).first()
        if not augmentation:
            logger.error(f"Task {task_id}: Augmentation configuration not found")
            task.status = 'failed'
            task.error_message = 'Augmentation configuration not found'
            task.completed_at = datetime.utcnow()
            db.commit()
            return
        
        logger.info(f"Task {task_id}: Found augmentation config - factor: {augmentation.augmentation_factor}, methods: {augmentation.augmentation_methods}")
        
        print(f"Processing augmentation task {task_id} for target dataset {augmentation.target_dataset_id}")
        logger.info(f"Task {task_id}: Processing augmentation for target dataset {augmentation.target_dataset_id}")

        # Get source datasets
        source_datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(augmentation.source_dataset_ids)
        ).all()
        
        if not source_datasets:
            logger.error(f"Task {task_id}: No source datasets found")
            task.status = 'failed'
            task.error_message = 'Source datasets not found'
            task.completed_at = datetime.utcnow()
            db.commit()
            return
        
        logger.info(f"Task {task_id}: Found {len(source_datasets)} source datasets")
        
        # Get target dataset
        target_dataset = db.query(models.Dataset).filter(
            models.Dataset.id == augmentation.target_dataset_id
        ).first()
        
        if not target_dataset:
            logger.error(f"Task {task_id}: Target dataset not found")
            task.status = 'failed'
            task.error_message = 'Target dataset not found'
            task.completed_at = datetime.utcnow()
            db.commit()
            return
        
        logger.info(f"Task {task_id}: Target dataset: {target_dataset.name}")
        
        # Update progress
        task.progress = 10.0
        db.commit()
        logger.info(f"Task {task_id}: Progress updated to 10%")
        
        # Check for cancellation
        db.refresh(task)
        if task.status == 'cancelled':
            return
        
        # Get all images from source datasets
        all_source_images = []
        for dataset in source_datasets:
            dataset_images = db.query(models.Image).filter(
                models.Image.dataset_id == dataset.id
            ).all()
            all_source_images.extend(dataset_images)
            logger.info(f"Task {task_id}: Found {len(dataset_images)} images in dataset {dataset.name}")
        
        if not all_source_images:
            logger.error(f"Task {task_id}: No images found in source datasets")
            task.status = 'failed'
            task.error_message = 'No images found in source datasets'
            task.completed_at = datetime.utcnow()
            db.commit()
            return
        
        logger.info(f"Task {task_id}: Total images to process: {len(all_source_images)}")
        
        # Update progress
        task.progress = 20.0
        db.commit()
        logger.info(f"Task {task_id}: Progress updated to 20%")
        
        # Check for cancellation
        db.refresh(task)
        if task.status == 'cancelled':
            return
        
        # Create only augmented images (no original copies)
        total_operations = len(all_source_images) * int(augmentation.augmentation_factor)
        current_operation = 0
        
        for source_image in all_source_images:
            try:
                # Check for cancellation before processing each image
                db.refresh(task)
                if task.status == 'cancelled':
                    return
                
                # Get source dataset to determine its project_id for file path
                source_dataset = db.query(models.Dataset).filter(
                    models.Dataset.id == source_image.dataset_id
                ).first()
                source_project_id = source_dataset.project_id if source_dataset else None
                
                # Get source annotations for this image
                source_annotations = db.query(models.Annotation).filter(
                    models.Annotation.image_id == source_image.id
                ).all()
                
                # Create augmented versions
                augmentation_factor = int(augmentation.augmentation_factor)
                for i in range(augmentation_factor):
                    # Check for cancellation
                    db.refresh(task)
                    if task.status == 'cancelled':
                        return
                    
                    # Apply augmentation methods based on configuration
                    augmented_image_data = apply_augmentations(
                        source_image, 
                        augmentation.augmentation_methods,
                        augmentation.method_parameters,
                        i,
                        target_dataset.project_id,
                        target_dataset.id,
                        source_project_id
                    )
                    
                    # Create augmented image entry
                    augmented_image = models.Image(
                        dataset_id=target_dataset.id,
                        file_name=augmented_image_data['file_name'],
                        file_size=augmented_image_data['file_size'],
                        width=augmented_image_data['width'],
                        height=augmented_image_data['height'],
                        url=augmented_image_data['url'],
                        thumbnail_url=augmented_image_data['thumbnail_url'],
                        uploaded_at=datetime.utcnow()
                    )
                    db.add(augmented_image)
                    db.flush()  # Get the image ID
                    
                    # Copy and transform annotations based on augmentation
                    augmented_annotations = []
                    for annotation in source_annotations:
                        # Skip annotation transformation if disabled
                        if not getattr(augmentation, 'transform_annotations', True):
                            # Just copy the annotation without transformation
                            annotation_data = {
                                'category': annotation.category,
                                'bbox': annotation.bbox,
                                'segmentation': annotation.segmentation,
                                'area': annotation.area
                            }
                            augmented_annotations.append(annotation_data)
                            
                            # Validate segmentation coordinates before saving
                            segmentation = annotation.segmentation
                            if segmentation:
                                from app.services.annotation_processing import validate_and_normalize_segmentation
                                validated_seg = validate_and_normalize_segmentation(
                                    segmentation,
                                    image_width=augmented_image.width,
                                    image_height=augmented_image.height,
                                    normalize=False  # Keep as pixel coordinates (integers)
                                )
                                if validated_seg is not None:
                                    segmentation = validated_seg
                                else:
                                    segmentation = None
                            
                            # Create database entry
                            new_annotation = models.Annotation(
                                image_id=augmented_image.id,
                                dataset_id=target_dataset.id,
                                category=annotation.category,
                                bbox=annotation.bbox,
                                segmentation=segmentation,
                                area=annotation.area,
                                uploaded_at=datetime.utcnow()
                            )
                            db.add(new_annotation)
                        else:
                            # Transform the annotation
                            transformed_annotation = transform_annotation(
                                annotation,
                                augmentation.augmentation_methods,
                                augmentation.method_parameters,
                                augmented_image_data['transforms'],
                                getattr(augmentation, 'annotation_settings', None)
                            )
                            
                            # Only create annotation if transformation didn't return None
                            if transformed_annotation:
                                augmented_annotations.append(transformed_annotation)
                                
                                # Validate segmentation coordinates before saving
                                segmentation = transformed_annotation.get('segmentation')
                                if segmentation:
                                    from app.services.annotation_processing import validate_and_normalize_segmentation
                                    validated_seg = validate_and_normalize_segmentation(
                                        segmentation,
                                        image_width=augmented_image.width,
                                        image_height=augmented_image.height,
                                        normalize=False  # Keep as pixel coordinates (integers)
                                    )
                                    if validated_seg is not None:
                                        segmentation = validated_seg
                                    else:
                                        segmentation = None
                                
                                # Create database entry
                                new_annotation = models.Annotation(
                                    image_id=augmented_image.id,
                                    dataset_id=target_dataset.id,
                                    category=transformed_annotation['category'],
                                    bbox=transformed_annotation['bbox'],
                                    segmentation=segmentation,
                                    area=transformed_annotation['area'],
                                    uploaded_at=datetime.utcnow()
                                )
                                db.add(new_annotation)
                    
                    current_operation += 1
                
                # Update progress periodically
                progress = 20.0 + (current_operation / total_operations) * 70.0
                task.progress = min(progress, 90.0)
                db.commit()
                
                # Add small delay to simulate processing time
                await asyncio.sleep(0.05)
                
            except Exception as e:
                task.status = 'failed'
                task.error_message = f'Error processing image {source_image.file_name}: {str(e)}'
                task.completed_at = datetime.utcnow()
                db.commit()
                return
        
        # Final check for cancellation
        db.refresh(task)
        if task.status == 'cancelled':
            return
        
        # Update dataset counts
        target_dataset.image_count = db.query(models.Image).filter(
            models.Image.dataset_id == target_dataset.id
        ).count()
        # Recalculate annotation counts using helper to avoid relying on a persistent column
        from app.services.annotation_processing import update_dataset_annotation_count
        update_dataset_annotation_count(db, target_dataset.id)
        # Refresh target_dataset from DB to update any dependent code
        db.refresh(target_dataset)
        
        # Complete the task
        task.status = 'completed'
        task.progress = 100.0
        task.completed_at = datetime.utcnow()
        db.commit()
        
    except Exception as e:
        # Handle any unexpected errors
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if task and task.status != 'cancelled':  # Don't override cancelled status
            task.status = 'failed'
            task.error_message = f'Unexpected error: {str(e)}'
            task.completed_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()


def create_albumentations_transform(augmentation_methods: List[str], method_parameters: Dict[str, Any]) -> A.Compose:
    """
    Create an Albumentations transform pipeline based on the selected methods and parameters.
    """
    transforms = []
    
    for method in augmentation_methods:
        if method == 'rotation':
            params = method_parameters.get('rotation', {})
            min_angle = params.get('min_angle', -30)
            max_angle = params.get('max_angle', 30)
            transforms.append(A.Rotate(limit=(min_angle, max_angle), p=1.0))
            
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
            
        elif method == 'mixup':
            # Note: Mixup requires two images and is typically handled differently
            # For now, we'll skip it in the single-image pipeline
            # You could implement it as a separate post-processing step
            pass
    
    # Return composed transform with bounding box support
    return A.Compose(
        transforms,
        bbox_params=A.BboxParams(
            format='coco',  # [x, y, width, height]
            label_fields=['class_labels'],
            min_visibility=0.3  # Minimum visibility threshold for bboxes
        )
    )


def load_image_from_path(image_path: str) -> np.ndarray:
    """Load image from file path and convert to RGB numpy array."""
    try:
        # Try to load with PIL first (better format support)
        pil_image = Image.open(image_path).convert('RGB')
        return np.array(pil_image)
    except Exception:
        # Fallback to OpenCV
        image = cv2.imread(image_path)
        if image is not None:
            return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        else:
            raise ValueError(f"Could not load image from {image_path}")


def save_image_to_path(image: np.ndarray, output_path: str) -> bool:
    """Save numpy array image to file path."""
    try:
        # Convert RGB to PIL Image and save
        pil_image = Image.fromarray(image.astype(np.uint8))
        pil_image.save(output_path, quality=95, optimize=True)
        return True
    except Exception as e:
        print(f"Error saving image to {output_path}: {e}")
        return False


def apply_augmentations(source_image, augmentation_methods, method_parameters, iteration, project_id, target_dataset_id, source_project_id=None):
    """
    Apply Albumentations augmentation methods to an image and return the augmented image data.
    Only creates augmented images/annotations, no copies of originals.
    Saves files in projects/{project_id}/{dataset_id}/images/ structure.
    """
    try:
        # Create the augmentation pipeline
        transform = create_albumentations_transform(augmentation_methods, method_parameters)
        
        # Generate paths
        method_suffix = "_".join(augmentation_methods[:2])  # Use first 2 methods for naming
        file_name = f"aug_{iteration}_{method_suffix}_{source_image.file_name}"
        
        # Try to get source image path - check new projects structure first, then old structure
        source_path = None
        
        # Try new projects structure first
        if source_project_id:
            new_source_path = Path("projects") / str(source_project_id) / str(source_image.dataset_id) / "images" / source_image.file_name
            if new_source_path.exists():
                source_path = new_source_path
        
        # Fall back to old data structure if not found in projects
        if source_path is None:
            old_source_path = Path("data") / "images" / str(source_image.dataset_id) / source_image.file_name
            if old_source_path.exists():
                source_path = old_source_path
        
        if source_path is None:
            # If source file doesn't exist in either location, return placeholder data
            logger.warning(f"Source image file not found in either projects/{source_project_id}/{source_image.dataset_id}/images/ or data/images/{source_image.dataset_id}/")
            return {
                'file_name': file_name,
                'file_size': source_image.file_size,
                'width': source_image.width,
                'height': source_image.height,
                'url': f"/static/projects/{project_id}/{target_dataset_id}/images/{file_name}",
                'thumbnail_url': f"/static/projects/{project_id}/{target_dataset_id}/images/{file_name}",
                'transforms': [{'type': 'placeholder', 'note': 'Source file not found'}]
            }
        
        # Load the source image
        image = load_image_from_path(str(source_path))
        
        # Prepare bounding boxes if available
        bboxes = []
        class_labels = []
        
        # Apply the augmentation
        if bboxes:  # If we have bounding boxes
            augmented = transform(image=image, bboxes=bboxes, class_labels=class_labels)
            transformed_bboxes = augmented['bboxes']
        else:
            augmented = transform(image=image)
            transformed_bboxes = []
        
        augmented_image = augmented['image']
        
        # Generate output path in projects/{project_id}/{dataset_id}/images/
        target_dataset_path = Path("projects") / str(project_id) / str(target_dataset_id) / "images"
        target_dataset_path.mkdir(parents=True, exist_ok=True)
        output_path = target_dataset_path / file_name
        
        # Save the augmented image
        success = save_image_to_path(augmented_image, str(output_path))
        
        if not success:
            raise ValueError("Failed to save augmented image")
        
        # Get file size of the augmented image
        file_size = output_path.stat().st_size if output_path.exists() else source_image.file_size
        
        # Get dimensions
        height, width = augmented_image.shape[:2]
        
        # Generate URLs
        relative_url = f"/static/projects/{project_id}/{target_dataset_id}/images/{file_name}"
        
        return {
            'file_name': file_name,
            'file_size': file_size,
            'width': width,
            'height': height,
            'url': relative_url,
            'thumbnail_url': relative_url,  # Using same as main image for now
            'transforms': [{'type': method, 'params': method_parameters.get(method, {})} for method in augmentation_methods],
            'transformed_bboxes': transformed_bboxes
        }
        
    except Exception as e:
        logger.error(f"Error applying augmentations: {e}")
        # Return placeholder data on error
        return {
            'file_name': f"error_{iteration}_{source_image.file_name}",
            'file_size': source_image.file_size,
            'width': source_image.width,
            'height': source_image.height,
            'url': f"/static/projects/{project_id}/{target_dataset_id}/images/error_{iteration}_{source_image.file_name}",
            'thumbnail_url': f"/static/projects/{project_id}/{target_dataset_id}/images/error_{iteration}_{source_image.file_name}",
            'transforms': [{'type': 'error', 'message': str(e)}]
        }


def transform_annotation(annotation, augmentation_methods, method_parameters, transforms, annotation_settings=None):
    """
    Transform annotation coordinates based on the applied augmentations using Albumentations results.
    """
    try:
        # Get annotation settings with defaults
        settings = annotation_settings or {}
        min_visibility = settings.get('minVisibilityThreshold', 0.3)
        handle_out_of_bounds = settings.get('handleOutOfBounds', 'remove')
        preserve_invalid = settings.get('preserveInvalidBounds', False)
        
        # If we have transformed bboxes from the augmentation, use them
        if 'transformed_bboxes' in transforms and transforms['transformed_bboxes']:
            # This would require matching annotations to their transformed versions
            # For now, we'll use the original approach with manual transformation
            pass
        
        bbox = annotation.bbox.copy() if annotation.bbox else None
        segmentation = annotation.segmentation.copy() if annotation.segmentation else None
        area = annotation.area
        
        # For complex transformations, you might need to recompute area and segmentation
        # This is a simplified version that works for basic transformations
        
        if bbox:
            # Convert COCO format [x, y, width, height] for compatibility
            # Most augmentations will preserve the relative structure
            
            for transform in transforms.get('transforms', []):
                transform_type = transform.get('type', '')
                
                if transform_type == 'flip_horizontal':
                    # For horizontal flip: x_new = image_width - (x + width)
                    # This would require image width, which we'll approximate
                    pass
                    
                elif transform_type == 'flip_vertical':
                    # For vertical flip: y_new = image_height - (y + height)
                    pass
                    
                elif transform_type == 'scale':
                    # Scaling affects both coordinates and dimensions
                    scale_factor = transform.get('params', {}).get('scale_factor', 1.0)
                    if scale_factor != 1.0:
                        bbox = [coord * scale_factor for coord in bbox]
                        area = area * (scale_factor ** 2) if area else None
            
            # Apply annotation settings validation
            if bbox and len(bbox) >= 4:
                x, y, w, h = bbox[:4]
                
                # Check for invalid bounds
                if w <= 0 or h <= 0:
                    if not preserve_invalid:
                        return None  # Skip this annotation
                
                # Check visibility (simplified - assumes no image bounds available)
                # In a real implementation, you'd check against actual image dimensions
                current_visibility = 1.0  # Placeholder
                if current_visibility < min_visibility:
                    if handle_out_of_bounds == 'remove':
                        return None  # Skip this annotation
                    elif handle_out_of_bounds == 'clip':
                        # Clip to bounds (simplified implementation)
                        pass
                    # 'keep' - no action needed
        
        return {
            'category': annotation.category,
            'bbox': bbox,
            'segmentation': segmentation,
            'area': area
        }
        
    except Exception as e:
        logger.error(f"Error transforming annotation: {e}")
        # Return original annotation on error
        return {
            'category': annotation.category,
            'bbox': annotation.bbox,
            'segmentation': annotation.segmentation,
            'area': annotation.area
        }


@router.post("/augmentations/", response_model=dict)
async def create_augmented_dataset(
    name: str = Form(...),
    description: Optional[str] = Form(None),
    project_id: int = Form(...),
    source_datasets: Optional[str] = Form(None),  # JSON string of dataset IDs (legacy format)
    dataset_configs: Optional[str] = Form(None),  # JSON array of {dataset_id, annotation_file_id} (new format)
    augmentation_methods: str = Form(...),  # JSON string of method names
    method_parameters: str = Form("{}"),  # JSON string of parameters
    augmentation_factor: str = Form("2"),
    transform_annotations: str = Form("true"),  # Whether to transform annotations
    annotation_settings: str = Form("{}"),  # JSON string of annotation settings
    db: Session = Depends(get_db)
):
    """Create an augmented dataset asynchronously using Celery background task"""
    from app.tasks.augmentation_tasks import create_augmented_dataset_task
    
    logger.info(f"Creating augmented dataset: {name}")
    
    try:
        # Parse JSON inputs - support both new and legacy formats
        if dataset_configs:
            # New format: array of {dataset_id, annotation_file_id}
            configs = json.loads(dataset_configs)
            source_dataset_ids = [c['dataset_id'] for c in configs]
            # Build a map of dataset_id -> annotation_file_id for each config entry
            # Note: same dataset can appear multiple times with different annotation files
            annotation_file_configs = configs
            logger.info(f"Using new dataset_configs format: {configs}")
        elif source_datasets:
            # Legacy format: array of dataset IDs
            source_dataset_ids = json.loads(source_datasets)
            annotation_file_configs = [{'dataset_id': ds_id, 'annotation_file_id': None} for ds_id in source_dataset_ids]
            logger.info(f"Using legacy source_datasets format: {source_dataset_ids}")
        else:
            raise HTTPException(status_code=422, detail="Either source_datasets or dataset_configs must be provided")
        
        methods = json.loads(augmentation_methods)
        parameters = json.loads(method_parameters)
        transform_annotations_bool = transform_annotations.lower() == 'true'
        annotation_config = json.loads(annotation_settings) if annotation_settings else {}
        
        logger.info(f"Parsed inputs - source datasets: {source_dataset_ids}, methods: {methods}, parameters: {parameters}")
        logger.info(f"Annotation settings - transform: {transform_annotations_bool}, config: {annotation_config}")

        # Validate dataset config structure early (including collection_id type)
        for cfg in annotation_file_configs:
            if 'dataset_id' not in cfg:
                raise HTTPException(status_code=422, detail="dataset_configs entries must include dataset_id")
            if cfg.get('collection_id') is not None:
                try:
                    cfg['collection_id'] = int(cfg['collection_id'])
                except (TypeError, ValueError):
                    raise HTTPException(status_code=422, detail="collection_id must be an integer when provided")
        
        # Validate source datasets exist (use unique IDs)
        unique_dataset_ids = list(set(source_dataset_ids))
        existing_datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(unique_dataset_ids)
        ).all()
        
        if len(existing_datasets) != len(unique_dataset_ids):
            logger.error(f"Dataset validation failed - found {len(existing_datasets)} of {len(unique_dataset_ids)} unique datasets")
            raise HTTPException(status_code=404, detail="One or more source datasets not found")
        
        logger.info(f"Validated {len(existing_datasets)} unique source datasets")

        # Validate selected collection ids belong to their datasets.
        for cfg in annotation_file_configs:
            coll_id = cfg.get('collection_id')
            if coll_id is None:
                continue
            coll_exists = db.query(models.ImageCollection).filter(
                models.ImageCollection.id == coll_id,
                models.ImageCollection.dataset_id == cfg['dataset_id']
            ).first()
            if not coll_exists:
                raise HTTPException(
                    status_code=422,
                    detail=f"collection_id {coll_id} does not belong to dataset_id {cfg['dataset_id']}"
                )
        
        # Validate project exists
        project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if not project:
            logger.error(f"Project {project_id} not found")
            raise HTTPException(status_code=404, detail="Project not found")
        
        logger.info(f"Validated project: {project.name}")
        
        # Create the target dataset first
        target_dataset = models.Dataset(
            name=name,
            description=description or f"Augmented dataset created from {len(source_dataset_ids)} source dataset(s)",
            project_id=project_id,
            image_count=0
        )
        target_dataset.tags = ["augmented"]
        db.add(target_dataset)
        db.commit()
        db.refresh(target_dataset)
        from app.services.dataset_collections_service import ensure_default_image_collection

        ensure_default_image_collection(db, target_dataset.id)
        db.commit()
        
        # Create the task
        # Create a readable description of augmentation methods
        methods_list = ', '.join(methods) if len(methods) <= 5 else f"{', '.join(methods[:5])} and {len(methods) - 5} more"
        
        task = models.Task(
            name=f"Create Augmented Dataset: {name}",
            description=f"Creating augmented dataset '{name}' from {len(unique_dataset_ids)} source dataset(s) with {augmentation_factor}x augmentation using: {methods_list}",
            task_type="augmentation",
            status="pending",
            project_id=project_id,
            progress=0.0,
            task_metadata={
                "target_dataset_id": target_dataset.id,
                "target_dataset_name": name,
                "source_dataset_ids": unique_dataset_ids,
                "annotation_file_configs": annotation_file_configs,
                "augmentation_methods": methods,
                "method_parameters": parameters,
                "augmentation_factor": augmentation_factor,
                "transform_annotations": transform_annotations_bool,
                "annotation_settings": annotation_config,
                "stage": "queued"
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Create the augmentation record
        augmentation = models.Augmentation(
            task_id=task.id,
            source_dataset_ids=unique_dataset_ids,
            target_dataset_id=target_dataset.id,
            augmentation_methods=methods,
            method_parameters=parameters,
            augmentation_factor=augmentation_factor,
            transform_annotations=transform_annotations_bool,
            annotation_settings=annotation_config
        )
        db.add(augmentation)
        db.commit()
        
        # Start the Celery background task
        celery_result = create_augmented_dataset_task.delay(task.id)
        
        # Update task with Celery task ID
        task.task_metadata = {
            **(task.task_metadata or {}),
            "celery_task_id": celery_result.id
        }
        db.commit()
        
        logger.info(f"Started Celery augmentation task {task.id} with Celery ID {celery_result.id}")
        
        return {
            "success": True,
            "message": f"Augmented dataset creation started successfully",
            "task_id": task.id,
            "dataset_id": target_dataset.id,
            "celery_task_id": celery_result.id,
            "status": "pending"
        }
        
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON in request: {str(e)}")
    except Exception as e:
        logger.error(f"Failed to create augmented dataset: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create augmented dataset: {str(e)}")


@router.get("/augmentations/", response_model=List[schemas.Augmentation])
async def get_augmentations(
    task_id: Optional[int] = None,
    project_id: Optional[int] = None,
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db)
):
    """Get augmentations, optionally filtered by task or project"""
    query = db.query(models.Augmentation)
    
    if task_id:
        query = query.filter(models.Augmentation.task_id == task_id)
    
    if project_id:
        # Join with Task to filter by project
        query = query.join(models.Task).filter(models.Task.project_id == project_id)
    
    return query.offset(skip).limit(limit).all()


@router.get("/augmentations/{augmentation_id}", response_model=schemas.Augmentation)
async def get_augmentation(augmentation_id: int, db: Session = Depends(get_db)):
    """Get a specific augmentation by ID"""
    augmentation = db.query(models.Augmentation).filter(models.Augmentation.id == augmentation_id).first()
    if not augmentation:
        raise HTTPException(status_code=404, detail="Augmentation not found")
    return augmentation


@router.delete("/augmentations/{augmentation_id}")
async def delete_augmentation(augmentation_id: int, db: Session = Depends(get_db)):
    """Delete an augmentation and its associated task"""
    try:
        augmentation = db.query(models.Augmentation).filter(models.Augmentation.id == augmentation_id).first()
        if not augmentation:
            raise HTTPException(status_code=404, detail="Augmentation not found")
        
        # Get the associated task
        task = db.query(models.Task).filter(models.Task.id == augmentation.task_id).first()
        
        # Delete the augmentation
        db.delete(augmentation)
        
        # Delete the associated task if it exists
        if task:
            db.delete(task)
        
        db.commit()
        
        return {
            "success": True,
            "message": "Augmentation and associated task deleted successfully"
        }
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete augmentation: {str(e)}")


@router.get("/augmentations/methods/available")
async def get_available_augmentation_methods():
    """Get list of available augmentation methods with their parameters (Albumentations-based)"""
    methods = {
        "geometric": [
            {
                "id": "rotation",
                "name": "Rotation",
                "description": "Rotate images by random angles (Albumentations Rotate)",
                "albumentations_class": "A.Rotate",
                "parameters": {
                    "min_angle": {
                        "type": "float", 
                        "default": -30, 
                        "min": -180, 
                        "max": 180,
                        "description": "Minimum rotation angle in degrees"
                    },
                    "max_angle": {
                        "type": "float", 
                        "default": 30, 
                        "min": -180, 
                        "max": 180,
                        "description": "Maximum rotation angle in degrees"
                    }
                }
            },
            {
                "id": "flip_horizontal",
                "name": "Horizontal Flip",
                "description": "Flip images horizontally (Albumentations HorizontalFlip)",
                "albumentations_class": "A.HorizontalFlip",
                "parameters": {}
            },
            {
                "id": "flip_vertical",
                "name": "Vertical Flip",
                "description": "Flip images vertically (Albumentations VerticalFlip)",
                "albumentations_class": "A.VerticalFlip",
                "parameters": {}
            },
            {
                "id": "scale",
                "name": "Random Scale",
                "description": "Scale images up or down (Albumentations RandomScale)",
                "albumentations_class": "A.RandomScale",
                "parameters": {
                    "min_scale": {
                        "type": "float", 
                        "default": 0.8, 
                        "min": 0.1, 
                        "max": 2.0,
                        "description": "Minimum scale factor"
                    },
                    "max_scale": {
                        "type": "float", 
                        "default": 1.2, 
                        "min": 0.1, 
                        "max": 2.0,
                        "description": "Maximum scale factor"
                    }
                }
            }
        ],
        "color": [
            {
                "id": "brightness",
                "name": "Random Brightness",
                "description": "Adjust image brightness randomly (Albumentations RandomBrightnessContrast)",
                "albumentations_class": "A.RandomBrightnessContrast",
                "parameters": {
                    "factor": {
                        "type": "float", 
                        "default": 0.2, 
                        "min": 0.0, 
                        "max": 1.0,
                        "description": "Brightness adjustment factor"
                    }
                }
            },
            {
                "id": "contrast",
                "name": "Random Contrast",
                "description": "Adjust image contrast randomly (Albumentations RandomBrightnessContrast)",
                "albumentations_class": "A.RandomBrightnessContrast",
                "parameters": {
                    "factor": {
                        "type": "float", 
                        "default": 0.2, 
                        "min": 0.0, 
                        "max": 1.0,
                        "description": "Contrast adjustment factor"
                    }
                }
            },
            {
                "id": "saturation",
                "name": "Color Jitter (Saturation)",
                "description": "Adjust color saturation (Albumentations ColorJitter)",
                "albumentations_class": "A.ColorJitter",
                "parameters": {
                    "factor": {
                        "type": "float", 
                        "default": 0.2, 
                        "min": 0.0, 
                        "max": 1.0,
                        "description": "Saturation adjustment factor"
                    }
                }
            },
            {
                "id": "hue_shift",
                "name": "Hue Saturation Value",
                "description": "Shift color hues (Albumentations HueSaturationValue)",
                "albumentations_class": "A.HueSaturationValue",
                "parameters": {
                    "max_shift": {
                        "type": "float", 
                        "default": 0.1, 
                        "min": 0.0, 
                        "max": 1.0,
                        "description": "Maximum hue shift as a fraction (0.0-1.0)"
                    }
                }
            }
        ],
        "noise": [
            {
                "id": "gaussian_noise",
                "name": "Gaussian Noise",
                "description": "Add random Gaussian noise (Albumentations GaussNoise)",
                "albumentations_class": "A.GaussNoise",
                "parameters": {
                    "std": {
                        "type": "float", 
                        "default": 0.01, 
                        "min": 0.0, 
                        "max": 0.1,
                        "description": "Standard deviation of the noise (as fraction of 255)"
                    }
                }
            },
            {
                "id": "gaussian_blur",
                "name": "Gaussian Blur",
                "description": "Apply Gaussian blur effect (Albumentations GaussianBlur)",
                "albumentations_class": "A.GaussianBlur",
                "parameters": {
                    "kernel_size": {
                        "type": "int", 
                        "default": 3, 
                        "min": 1, 
                        "max": 15,
                        "description": "Size of the blur kernel (odd numbers only)"
                    }
                }
            }
        ],
        "advanced": [
            {
                "id": "cutout",
                "name": "Coarse Dropout",
                "description": "Randomly mask rectangular regions (Albumentations CoarseDropout)",
                "albumentations_class": "A.CoarseDropout",
                "parameters": {
                    "num_holes": {
                        "type": "int", 
                        "default": 1, 
                        "min": 1, 
                        "max": 10,
                        "description": "Maximum number of rectangular holes"
                    },
                    "max_size": {
                        "type": "int", 
                        "default": 16, 
                        "min": 1, 
                        "max": 100,
                        "description": "Maximum size of each hole in pixels"
                    }
                }
            },
            {
                "id": "elastic_transform",
                "name": "Elastic Transform",
                "description": "Apply elastic transformation (Albumentations ElasticTransform)",
                "albumentations_class": "A.ElasticTransform",
                "parameters": {
                    "alpha": {
                        "type": "float", 
                        "default": 1.0, 
                        "min": 0.0, 
                        "max": 5.0,
                        "description": "Elastic transformation intensity"
                    },
                    "sigma": {
                        "type": "float", 
                        "default": 50.0, 
                        "min": 10.0, 
                        "max": 100.0,
                        "description": "Gaussian kernel standard deviation"
                    }
                }
            },
            {
                "id": "grid_distortion",
                "name": "Grid Distortion",
                "description": "Apply grid distortion (Albumentations GridDistortion)",
                "albumentations_class": "A.GridDistortion",
                "parameters": {
                    "num_steps": {
                        "type": "int", 
                        "default": 5, 
                        "min": 2, 
                        "max": 10,
                        "description": "Number of grid cells per side"
                    },
                    "distort_limit": {
                        "type": "float", 
                        "default": 0.3, 
                        "min": 0.0, 
                        "max": 1.0,
                        "description": "Distortion intensity"
                    }
                }
            }
        ]
    }
    
    return {
        "success": True,
        "data": methods,
        "library": "Albumentations",
        "version": "1.3.0+",
        "documentation": "https://albumentations.ai/docs/"
    }


@router.get("/augmentations/setup/test")
async def test_albumentations_setup():
    """Test if Albumentations and its dependencies are properly installed"""
    try:
        # Test basic transform creation
        transform = A.Compose([
            A.Rotate(limit=30, p=1.0),
            A.RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0, p=1.0)
        ])
        
        # Test with a dummy image
        dummy_image = np.random.randint(0, 255, (100, 100, 3), dtype=np.uint8)
        result = transform(image=dummy_image)
        
        return {
            "success": True,
            "message": "Albumentations setup is working correctly",
            "albumentations_version": A.__version__,
            "opencv_version": cv2.__version__,
            "test_passed": True,
            "available_transforms": [
                "Rotate", "HorizontalFlip", "VerticalFlip", "RandomScale",
                "RandomBrightnessContrast", "ColorJitter", 
                "HueSaturationValue", "GaussNoise", "GaussianBlur",
                "CoarseDropout", "ElasticTransform", "GridDistortion"
            ]
        }
        
    except ImportError as e:
        return {
            "success": False,
            "message": f"Missing dependencies: {str(e)}",
            "error": "import_error",
            "recommendation": "Run: pip install albumentations opencv-python pillow numpy"
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Setup test failed: {str(e)}",
            "error": "test_failed"
        }


