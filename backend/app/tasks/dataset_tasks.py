"""
Celery tasks for dataset operations.
"""
import os
import json
import shutil
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any
import uuid

from celery import Task
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.general_app import celery_app
from app.models import Task as TaskModel, Dataset, Image, ImageCollection, AnnotationFile, Annotation, AnnotationClass, AnnotationFileImage
from app.database import get_db

logger = logging.getLogger(__name__)

# Database setup for Celery workers
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db/lai_db')
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class DatasetDuplicationTask(Task):
    """Base task for dataset duplication with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails"""
        logger.error(f"Task {task_id} failed: {exc}")
        
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


@celery_app.task(base=DatasetDuplicationTask, bind=True, name='app.tasks.dataset_tasks.duplicate_dataset')
def duplicate_dataset_task(self, task_id: int, dataset_id: int):
    """
    Celery task to duplicate a dataset with all its data.
    This task is executed by Celery worker with proper queuing and progress updates.
    """
    logger.info(f"Starting dataset duplication task {task_id} (Celery task {self.request.id})")
    db = SessionLocal()
    
    try:
        # Get the task record
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            raise Exception(f"Task {task_id} not found")
        
        # Update task status
        task.status = 'running'
        task.started_at = datetime.utcnow()
        task.progress = 0
        db.commit()
        
        # Get the original dataset
        original_dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not original_dataset:
            raise Exception(f"Dataset {dataset_id} not found")
        
        logger.info(f"Duplicating dataset: {original_dataset.name} (ID: {dataset_id})")
        
        # Step 1: Create new dataset (5% progress)
        task.progress = 5
        db.commit()
        
        new_dataset = Dataset(
            name=f"{original_dataset.name} (Copy)",
            description=original_dataset.description,
            _tags=original_dataset._tags,
            project_id=original_dataset.project_id,
            logo=original_dataset.logo,
            logo_url=original_dataset.logo_url,
            thumbnailUrl=original_dataset.thumbnailUrl,
            image_count=original_dataset.image_count
        )
        db.add(new_dataset)
        db.flush()  # Get the new dataset ID
        
        new_dataset_id = new_dataset.id
        project_id = original_dataset.project_id
        
        logger.info(f"Created new dataset with ID: {new_dataset_id}")
        
        # Create directory structure for new dataset
        original_dir = Path("projects") / str(project_id) / str(dataset_id)
        new_dir = Path("projects") / str(project_id) / str(new_dataset_id)
        new_dir.mkdir(parents=True, exist_ok=True)
        
        # Map old IDs to new IDs for reference updates
        collection_id_map = {}
        image_id_map = {}
        annotation_file_id_map = {}
        
        # Step 2: Copy image collections (10% progress)
        task.progress = 10
        db.commit()
        
        original_collections = db.query(ImageCollection).filter(
            ImageCollection.dataset_id == dataset_id
        ).all()
        
        for collection in original_collections:
            new_collection = ImageCollection(
                dataset_id=new_dataset_id,
                name=collection.name,
                description=collection.description,
                is_default=collection.is_default
            )
            db.add(new_collection)
            db.flush()
            collection_id_map[collection.id] = new_collection.id
        
        logger.info(f"Copied {len(original_collections)} image collections")
        
        # Step 3: Copy images (20-50% progress)
        original_images = db.query(Image).filter(
            Image.dataset_id == dataset_id
        ).all()
        
        total_images = len(original_images)
        logger.info(f"Copying {total_images} images...")
        
        # Create images directory
        new_images_dir = new_dir / "images"
        new_images_dir.mkdir(parents=True, exist_ok=True)
        
        for idx, image in enumerate(original_images):
            # Copy physical file
            old_image_path = original_dir / "images" / image.file_name
            new_image_path = new_images_dir / image.file_name
            
            if old_image_path.exists():
                shutil.copy2(old_image_path, new_image_path)
            
            # Update URL to point to new dataset
            new_url = image.url.replace(f"/{dataset_id}/", f"/{new_dataset_id}/") if image.url else None
            new_thumbnail_url = image.thumbnail_url.replace(f"/{dataset_id}/", f"/{new_dataset_id}/") if image.thumbnail_url else None
            
            # Map old collection ID to new one
            new_collection_id = collection_id_map.get(image.collection_id) if image.collection_id else None
            
            new_image = Image(
                dataset_id=new_dataset_id,
                file_name=image.file_name,
                file_size=image.file_size,
                width=image.width,
                height=image.height,
                url=new_url,
                thumbnail_url=new_thumbnail_url,
                annotations_count=image.annotations_count,
                collection_id=new_collection_id
            )
            db.add(new_image)
            db.flush()
            image_id_map[image.id] = new_image.id
            
            # Update progress
            if total_images > 0 and (idx + 1) % max(1, total_images // 10) == 0:
                progress = 20 + int((idx + 1) / total_images * 30)
                task.progress = min(progress, 50)
                db.commit()
        
        logger.info(f"Copied {total_images} images")
        
        # Step 4: Copy annotation files (50-70% progress)
        task.progress = 50
        db.commit()
        
        original_annotation_files = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id
        ).all()
        
        total_ann_files = len(original_annotation_files)
        logger.info(f"Copying {total_ann_files} annotation files...")
        
        # Create annotations directory
        new_annotations_dir = new_dir / "annotations"
        new_annotations_dir.mkdir(parents=True, exist_ok=True)
        
        for idx, ann_file in enumerate(original_annotation_files):
            # Generate new UUID for the annotation file
            new_ann_file_id = str(uuid.uuid4())
            
            # Copy physical annotation file if it exists
            old_ann_file_path = original_dir / "annotations" / f"{ann_file.id}.json"
            new_ann_file_path = new_annotations_dir / f"{new_ann_file_id}.json"
            
            if old_ann_file_path.exists():
                shutil.copy2(old_ann_file_path, new_ann_file_path)
            
            new_ann_file = AnnotationFile(
                id=new_ann_file_id,
                dataset_id=new_dataset_id,
                name=ann_file.name,
                format=ann_file.format,
                type=ann_file.type,
                _tags=ann_file._tags,
                file_size=ann_file.file_size,
                annotation_count=ann_file.annotation_count,
                image_count=ann_file.image_count,
                category_count=ann_file.category_count,
                statistics=ann_file.statistics,
                is_processed=ann_file.is_processed,
                processing_status=ann_file.processing_status
            )
            db.add(new_ann_file)
            db.flush()
            annotation_file_id_map[ann_file.id] = new_ann_file_id
            
            # Copy annotation classes for this file
            original_classes = db.query(AnnotationClass).filter(
                AnnotationClass.annotation_file_id == ann_file.id
            ).all()
            
            for ann_class in original_classes:
                new_ann_class = AnnotationClass(
                    annotation_file_id=new_ann_file_id,
                    class_name=ann_class.class_name,
                    category_id=ann_class.category_id,
                    count=ann_class.count,
                    color=ann_class.color,
                    opacity=ann_class.opacity
                )
                db.add(new_ann_class)
            
            # Copy annotation file images
            original_ann_images = db.query(AnnotationFileImage).filter(
                AnnotationFileImage.annotation_file_id == ann_file.id
            ).all()
            
            for ann_image in original_ann_images:
                new_dataset_image_id = image_id_map.get(ann_image.dataset_image_id) if ann_image.dataset_image_id else None
                new_ann_image = AnnotationFileImage(
                    annotation_file_id=new_ann_file_id,
                    coco_image_id=ann_image.coco_image_id,
                    file_name=ann_image.file_name,
                    dataset_image_id=new_dataset_image_id,
                    width=ann_image.width,
                    height=ann_image.height
                )
                db.add(new_ann_image)
            
            # Update progress
            if total_ann_files > 0 and (idx + 1) % max(1, total_ann_files // 5) == 0:
                progress = 50 + int((idx + 1) / total_ann_files * 20)
                task.progress = min(progress, 70)
                db.commit()
        
        logger.info(f"Copied {total_ann_files} annotation files")
        
        # Step 5: Copy annotations (70-95% progress)
        task.progress = 70
        db.commit()
        
        original_annotations = db.query(Annotation).filter(
            Annotation.dataset_id == dataset_id
        ).all()
        
        total_annotations = len(original_annotations)
        logger.info(f"Copying {total_annotations} annotations...")
        
        for idx, annotation in enumerate(original_annotations):
            new_image_id = image_id_map.get(annotation.image_id) if annotation.image_id else None
            new_ann_file_id = annotation_file_id_map.get(annotation.annotation_file_id) if annotation.annotation_file_id else None
            
            new_annotation = Annotation(
                annotation_file_id=new_ann_file_id,
                image_id=new_image_id,
                dataset_id=new_dataset_id,
                coco_image_id=annotation.coco_image_id,
                coco_annotation_id=annotation.coco_annotation_id,
                category_id=annotation.category_id,
                category=annotation.category,
                bbox_x=annotation.bbox_x,
                bbox_y=annotation.bbox_y,
                bbox_width=annotation.bbox_width,
                bbox_height=annotation.bbox_height,
                bbox=annotation.bbox,
                segmentation=annotation.segmentation,
                area=annotation.area,
                confidence=annotation.confidence
            )
            db.add(new_annotation)
            
            # Update progress
            if total_annotations > 0 and (idx + 1) % max(1, total_annotations // 10) == 0:
                progress = 70 + int((idx + 1) / total_annotations * 25)
                task.progress = min(progress, 95)
                db.commit()
        
        logger.info(f"Copied {total_annotations} annotations")
        
        # Step 6: Finalize (100% progress)
        task.progress = 100
        task.status = 'completed'
        task.completed_at = datetime.utcnow()
        
        # Store the new dataset ID in task metadata
        task.task_metadata = {
            **(task.task_metadata or {}),
            "original_dataset_id": dataset_id,
            "new_dataset_id": new_dataset_id,
            "new_dataset_name": new_dataset.name,
            "images_copied": total_images,
            "annotations_copied": total_annotations,
            "annotation_files_copied": total_ann_files
        }
        
        db.commit()
        db.refresh(new_dataset)
        
        logger.info(f"Dataset duplication completed successfully. New dataset ID: {new_dataset_id}")
        
        return {
            "success": True,
            "new_dataset_id": new_dataset_id,
            "new_dataset_name": new_dataset.name
        }
        
    except Exception as e:
        logger.error(f"Error duplicating dataset: {str(e)}", exc_info=True)
        
        # Update task status
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if task:
            task.status = 'failed'
            task.completed_at = datetime.utcnow()
            task.error_message = str(e)
            db.commit()
        
        raise
    finally:
        db.close()
