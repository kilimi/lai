"""Dataset domain services (extracted from datasets router)."""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import BackgroundTasks, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.database import SessionLocal
from app.task_dispatch import ensure_inline_dispatch_allowed, use_celery_enabled
logger = logging.getLogger(__name__)

def get_annotation_file_coverage(db: Session, dataset_id: int, annotation_file_id: str) -> dict:
    """Return coverage info for a single annotation file: which images referenced are present/missing."""
    try:
        # Verify file
        af = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_file_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        if not af:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        # Get all AnnotationFileImage entries for the file
        from app.models import AnnotationFileImage
        afi_list = db.query(AnnotationFileImage).filter(AnnotationFileImage.annotation_file_id == annotation_file_id).all()

        total_referenced = len(afi_list)
        present = []
        missing = []
        for afi in afi_list:
            if afi.dataset_image_id:
                # Ensure the referenced image still exists
                img = db.query(models.Image).filter(models.Image.id == afi.dataset_image_id, models.Image.dataset_id == dataset_id).first()
                if img:
                    present.append({"image_id": img.id, "file_name": img.file_name})
                else:
                    missing.append({"coco_image_id": afi.coco_image_id, "file_name": afi.file_name})
            else:
                missing.append({"coco_image_id": afi.coco_image_id, "file_name": afi.file_name})

        return {
            "success": True,
            "data": {
                "annotation_file_id": annotation_file_id,
                "total_referenced_images": total_referenced,
                "present_count": len(present),
                "missing_count": len(missing),
                "present": present,
                "missing": missing
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_annotation_file_coverage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def get_annotation_file_collection_counts(db: Session, dataset_id: int, annotation_file_id: str) -> dict:
    """Return annotation counts per image collection for a given annotation file."""
    try:
        af = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_file_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        if not af:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        collections = db.query(models.ImageCollection).filter(
            models.ImageCollection.dataset_id == dataset_id
        ).all()

        grouped_rows = (
            db.query(
                models.Image.collection_id,
                func.count(models.Annotation.id).label("annotation_count"),
            )
            .join(models.Image, models.Image.id == models.Annotation.image_id)
            .filter(
                models.Annotation.annotation_file_id == annotation_file_id,
                models.Image.dataset_id == dataset_id,
            )
            .group_by(models.Image.collection_id)
            .all()
        )

        grouped_map = {
            int(row.collection_id): int(row.annotation_count or 0)
            for row in grouped_rows
            if row.collection_id is not None
        }

        return {
            "success": True,
            "data": [
                {
                    "collection_id": int(col.id),
                    "collection_name": col.name,
                    "annotation_count": grouped_map.get(int(col.id), 0),
                }
                for col in collections
            ],
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_annotation_file_collection_counts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def get_dataset_annotations_coverage(db: Session, dataset_id: int) -> dict:
    """Return coverage summary for all annotation files in a dataset."""
    try:
        files = db.query(models.AnnotationFile).filter(models.AnnotationFile.dataset_id == dataset_id).order_by(models.AnnotationFile.created_at.desc()).all()
        result = []
        from app.models import AnnotationFileImage
        for f in files:
            afi_list = db.query(AnnotationFileImage).filter(AnnotationFileImage.annotation_file_id == f.id).all()
            total = len(afi_list)
            present_count = 0
            for afi in afi_list:
                if afi.dataset_image_id:
                    img = db.query(models.Image).filter(models.Image.id == afi.dataset_image_id, models.Image.dataset_id == dataset_id).first()
                    if img:
                        present_count += 1
            result.append({
                "annotation_file_id": f.id,
                "name": f.name,
                "total_referenced_images": total,
                "present_count": present_count,
                "missing_count": total - present_count
            })

        return {"success": True, "data": result}

    except Exception as e:
        print(f"Error in get_dataset_annotations_coverage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def import_annotations(
    db: Session,
    dataset_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile,
) -> dict:
    """Import annotations from a file (COCO format) - Database storage only"""
    print(f"DEBUG: import_annotations endpoint called for dataset {dataset_id}, file: {file.filename}")
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Read the uploaded file
        contents = await file.read()
        
        # Generate a random ID for the annotation file to avoid conflicts
        import uuid
        random_id = str(uuid.uuid4())[:8]  # Use first 8 characters of UUID
        
        # Try to parse as JSON (COCO format) to get statistics
        imported_count = 0
        image_count = 0
        category_count = 0
        coco_data = None
        
        try:
            coco_data = json.loads(contents.decode('utf-8'))
            
            # Basic COCO format processing - just count
            if 'annotations' in coco_data:
                imported_count = len(coco_data['annotations'])
            
            if 'images' in coco_data:
                image_count = len(coco_data['images'])
                
            if 'categories' in coco_data:
                category_count = len(coco_data['categories'])
                
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Only COCO JSON format is supported")
        
        if not coco_data:
            raise HTTPException(status_code=400, detail="Invalid COCO format")
        
        # Use database-based storage
        from app.services.annotation_processing import process_coco_annotation_file, detect_annotation_type
        
        # Detect annotation type from COCO data
        detected_type = detect_annotation_type(coco_data)
        
        # Create database record for the annotation file
        annotation_file_record = models.AnnotationFile(
            id=random_id,
            dataset_id=dataset_id,
            name=file.filename,
            format='COCO',
            type=detected_type,  # Set type based on detection
            file_size=len(contents),
            annotation_count=imported_count,  # Set initial count from COCO data
            image_count=image_count,  # Set initial count from COCO data
            category_count=category_count,  # Set initial count from COCO data
            is_processed=False,
            processing_status="pending"
        )
        
        db.add(annotation_file_record)
        db.commit()
        
        # Save the file to disk for the background task to process
        import os
        os.makedirs(f'/app/projects/{dataset_id}', exist_ok=True)
        file_path = f'/app/projects/{dataset_id}/{random_id}.json'
        with open(file_path, 'w') as f:
            json.dump(coco_data, f)
        
        print(f"DEBUG: About to add background task for annotation file {random_id}")
        # Process the file in the background using a fresh DB session
        # Do not pass the request-scoped session `db` into background tasks
        background_tasks.add_task(
            process_coco_annotation_file,
            random_id,
            coco_data
        )
        print(f"DEBUG: Background task added for annotation file {random_id}")
        
        return {
            "success": True,
            "data": {
                "message": f"Annotation file '{file.filename}' uploaded and processing started",
                "file_id": random_id,
                "original_filename": file.filename,
                "processing_status": "pending",
                "use_database": True,
                "estimated_annotations": imported_count,
                "estimated_images": image_count,
                "estimated_categories": category_count
            }
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import annotations: {str(e)}")


async def create_annotation_processing_task(
    db: Session,
    dataset_id: int,
    file: UploadFile,
    annotation_type: Optional[str],
    task_name: Optional[str],
) -> dict:
    """Create a background task for annotation processing"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Read the uploaded file
        contents = await file.read()
        
        # Generate a random ID for the annotation file
        import uuid
        file_id = str(uuid.uuid4())[:8]
        
        # Validate file format
        try:
            coco_data = json.loads(contents.decode('utf-8'))
            if not all(key in coco_data for key in ['images', 'annotations', 'categories']):
                raise HTTPException(status_code=400, detail="Invalid COCO format - missing required fields")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Only COCO JSON format is supported")
        
        # Get basic statistics and detect annotation type
        annotation_count = len(coco_data.get('annotations', []))
        image_count = len(coco_data.get('images', []))
        category_count = len(coco_data.get('categories', []))
        
        # Detect annotation type from the COCO data
        from app.services.annotation_processing import detect_annotation_type
        detected_type = detect_annotation_type(coco_data)
        
        # Create the annotation file record (initially not processed)
        annotation_file_record = models.AnnotationFile(
            id=file_id,
            dataset_id=dataset_id,
            name=file.filename,
            format='COCO',
            type=detected_type,  # Set type based on detection
            file_size=len(contents),
            annotation_count=annotation_count,
            image_count=image_count,
            category_count=category_count,
            is_processed=False,
            processing_status="pending"
        )
        
        db.add(annotation_file_record)
        db.flush()  # Get the ID without committing
        
        # Create the task record
        task_name_final = task_name or f"Process annotation file: {file.filename}"
        task_description = f"Processing annotation file '{file.filename}' for dataset '{dataset.name}' ({annotation_count} annotations, {image_count} images)"
        
        task = models.Task(
            name=task_name_final,
            description=task_description,
            task_type='annotation_processing',
            status='pending',
            progress=0,
            project_id=dataset.project_id,
            task_metadata={
                'dataset_id': dataset_id,
                'file_id': file_id,
                'filename': file.filename,
                'annotation_type': annotation_type,
                'file_size': len(contents),
                'annotation_count': annotation_count,
                'image_count': image_count,
                'category_count': category_count,
                'coco_data': coco_data  # Store the actual data for processing
            }
        )
        
        db.add(task)
        db.commit()
        
        # Save the task ID before the task object becomes detached
        task_id = task.id

        if use_celery_enabled():
            from app.tasks.annotation_tasks import process_annotation_file

            celery_job = process_annotation_file.delay(task_id, dataset_id, file_id)
            task.task_metadata = {
                **(task.task_metadata or {}),
                "celery_task_id": celery_job.id,
            }
            db.commit()
        else:
            ensure_inline_dispatch_allowed("Annotation processing")
            from app.task_stop import TaskStopped, handle_task_failure_status, run_annotation_file_processing

            session = SessionLocal()
            try:
                task_db = session.query(models.Task).filter(models.Task.id == task_id).first()
                if task_db:
                    task_db.status = "running"
                    task_db.started_at = datetime.utcnow()
                    task_db.progress = 10
                    session.commit()
                run_annotation_file_processing(
                    session,
                    task_id=task_id,
                    file_id=file_id,
                    coco_data=coco_data,
                )
            except TaskStopped:
                pass
            except Exception as e:
                handle_task_failure_status(session, task_id, e)
            finally:
                session.close()

        return {
            "success": True,
            "data": {
                "task_id": task_id,
                "file_id": file_id,
                "status": "pending",
                "message": f"Annotation processing task created for '{file.filename}'"
            }
        }
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create annotation processing task: {str(e)}")


async def delete_dataset_annotation(db: Session, dataset_id: int, annotation_id: str) -> dict:
    """Delete an annotation file by its ID (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Find the annotation file in database
        db_annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not db_annotation_file:
            raise HTTPException(
                status_code=404,
                detail=f"Annotation file with ID '{annotation_id}' not found in dataset {dataset_id}"
            )
        
        # Get count for reporting
        annotations_count = db_annotation_file.annotation_count
        
        # Delete the database record (this will cascade delete all annotations and classes)
        db.delete(db_annotation_file)
        db.commit()
        
        return {
            "success": True,
            "message": f"Annotation file '{db_annotation_file.name}' deleted successfully",
            "annotations_removed": annotations_count
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error deleting annotation file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete annotation file: {str(e)}")


async def get_dataset_annotations(db: Session, dataset_id: int) -> dict:
    """Get all annotation files for a dataset (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Get all annotation file records from database, ordered by creation date (newest first)
        db_annotation_files = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.dataset_id == dataset_id
        ).order_by(models.AnnotationFile.created_at.desc()).all()

        from app.services.annotation_processing import (
            get_live_annotation_counts_by_file_id,
            get_annotated_image_counts_by_file_id,
            resolve_annotation_count,
            detect_annotation_type_from_db_annotations,
        )

        file_ids = [f.id for f in db_annotation_files if f.id]
        live_counts_by_file = get_live_annotation_counts_by_file_id(db, file_ids)
        live_image_counts_by_file = get_annotated_image_counts_by_file_id(db, file_ids)
        needs_count_sync = False
        needs_type_sync = False

        annotation_files = []
        for db_file in db_annotation_files:
            # Calculate correct image coverage from AnnotationFileImage table
            from app.models import AnnotationFileImage
            afi_list = db.query(AnnotationFileImage).filter(AnnotationFileImage.annotation_file_id == db_file.id).all()
            
            total_referenced_images = len(afi_list)
            present_count = sum(1 for afi in afi_list if afi.dataset_image_id is not None)
            missing_count = total_referenced_images - present_count

            live_count = int(live_counts_by_file.get(db_file.id, 0))
            effective_count = resolve_annotation_count(db_file.annotation_count, live_count)
            if live_count > 0 and live_count != int(db_file.annotation_count or 0):
                db_file.annotation_count = live_count
                needs_count_sync = True

            live_image_count = int(live_image_counts_by_file.get(db_file.id, 0))
            effective_image_count = live_image_count if live_image_count > 0 else int(db_file.image_count or 0)
            if live_image_count > 0 and live_image_count != int(db_file.image_count or 0):
                db_file.image_count = live_image_count
                needs_count_sync = True

            effective_type = db_file.type
            if live_count > 0 and db_file.type == 'Segmentation (mask+bbox)':
                sample_rows = (
                    db.query(models.Annotation)
                    .filter(models.Annotation.annotation_file_id == db_file.id)
                    .limit(100)
                    .all()
                )
                detected_type = detect_annotation_type_from_db_annotations(sample_rows)
                if detected_type and detected_type != db_file.type:
                    db_file.type = detected_type
                    effective_type = detected_type
                    needs_type_sync = True

            file_info = {
                "id": db_file.id,
                "name": db_file.name,
                "format": db_file.format or 'COCO',
                "type": effective_type,
                "tags": db_file.tags,
                "size": db_file.file_size or 0,
                "annotation_count": effective_count,
                "image_count": effective_image_count,
                "referenced_image_count": total_referenced_images,
                "image_coverage": {
                    "total_referenced": total_referenced_images,
                    "present": present_count,
                    "missing": missing_count
                },
                "category_count": db_file.category_count,
                "is_processed": db_file.is_processed,
                "processing_status": db_file.processing_status,
                "error_message": db_file.error_message,
                "created_at": db_file.created_at.isoformat(),
                "modified_at": db_file.updated_at.isoformat(),
            }
            annotation_files.append(file_info)

        if needs_count_sync or needs_type_sync:
            db.commit()

        return {
            "success": True,
            "data": annotation_files
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_dataset_annotations: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get annotations: {str(e)}")


async def get_dataset_annotation(db: Session, dataset_id: int, annotation_id: str) -> dict:
    """Get a specific annotation file metadata"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Get the specific annotation file record from database
        db_annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not db_annotation_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        from app.services.annotation_processing import get_annotated_image_counts_by_file_id
        live_image_count = get_annotated_image_counts_by_file_id(db, [annotation_id]).get(annotation_id, 0)
        effective_image_count = live_image_count if live_image_count > 0 else int(db_annotation_file.image_count or 0)
        if live_image_count > 0 and live_image_count != int(db_annotation_file.image_count or 0):
            db_annotation_file.image_count = live_image_count
            db.commit()
        
        file_info = {
            "id": db_annotation_file.id,
            "name": db_annotation_file.name,
            "file_name": db_annotation_file.name,  # Add file_name for compatibility
            "format": db_annotation_file.format or 'COCO',
            "type": db_annotation_file.type,
            "tags": db_annotation_file.tags,
            "size": db_annotation_file.file_size or 0,
            "annotation_count": db_annotation_file.annotation_count,
            "image_count": effective_image_count,
            "category_count": db_annotation_file.category_count,
            "is_processed": db_annotation_file.is_processed,
            "processing_status": db_annotation_file.processing_status,
            "error_message": db_annotation_file.error_message,
            "created_at": db_annotation_file.created_at.isoformat(),
            "modified_at": db_annotation_file.updated_at.isoformat(),
        }
        
        return {
            "success": True,
            "data": file_info
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_dataset_annotation: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get annotation: {str(e)}")


async def get_dataset_annotations_summary(db: Session, dataset_id: int) -> dict:
    """Get fast summary of annotation data (counts only) for a dataset"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Fast aggregated queries using COUNT()
        from sqlalchemy import func
        
        # Get annotation file count and total annotation count efficiently
        file_count_result = db.query(func.count(models.AnnotationFile.id)).filter(
            models.AnnotationFile.dataset_id == dataset_id
        ).scalar()
        
        total_annotations_result = db.query(func.count(models.Annotation.id)).filter(
            models.Annotation.dataset_id == dataset_id
        ).scalar()
        
        # Get annotations per file efficiently
        files_with_counts = db.query(
            models.AnnotationFile.id,
            models.AnnotationFile.name,
            models.AnnotationFile.annotation_count,
            models.AnnotationFile.image_count,
            models.AnnotationFile.processing_status,
            func.count(models.Annotation.id).label("actual_count")
        ).outerjoin(
            models.Annotation, models.AnnotationFile.id == models.Annotation.annotation_file_id
        ).filter(
            models.AnnotationFile.dataset_id == dataset_id
        ).group_by(models.AnnotationFile.id).all()
        
        file_summaries = []
        for file_data in files_with_counts:
            file_summaries.append({
                "id": file_data.id,
                "name": file_data.name,
                "stored_count": file_data.annotation_count or 0,
                "actual_count": file_data.actual_count or 0,
                "image_count": file_data.image_count or 0,
                "processing_status": file_data.processing_status
            })
        
        return {
            "success": True,
            "data": {
                "dataset_id": dataset_id,
                "file_count": file_count_result or 0,
                "total_annotations": total_annotations_result or 0,
                "files": file_summaries
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_dataset_annotations_summary: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get annotation summary: {str(e)}")


async def get_dataset_annotations_list(
    dataset_id: int,
    page: int = 1,
    limit: int = 1000,
    annotation_file_id: Optional[str] = None
):
    """Get individual annotations from annotation files with pagination (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Build query with optional filtering by annotation file
        query = db.query(models.Annotation).filter(models.Annotation.dataset_id == dataset_id)
        
        if annotation_file_id:
            query = query.filter(models.Annotation.annotation_file_id == annotation_file_id)
        
        # Get total count efficiently
        total_count = query.count()
        
        # Apply pagination
        offset = (page - 1) * limit
        annotations = query.offset(offset).limit(limit).all()
        
        all_annotations = []
        for ann in annotations:
            annotation_data = {
                'id': ann.id,
                'annotation_file_id': ann.annotation_file_id,
                'image_id': ann.image_id,
                'dataset_id': ann.dataset_id,
                'coco_image_id': ann.coco_image_id,
                'coco_annotation_id': ann.coco_annotation_id,
                'category_id': ann.category_id,
                'category': ann.category,
                'bbox_x': ann.bbox_x,
                'bbox_y': ann.bbox_y,
                'bbox_width': ann.bbox_width,
                'bbox_height': ann.bbox_height,
                'bbox': ann.bbox,
                'segmentation': ann.segmentation,
                'area': ann.area,
                'confidence': ann.confidence,
                'uploaded_at': ann.uploaded_at.isoformat()
            }
            all_annotations.append(annotation_data)
        
        print(f"Found {len(all_annotations)} annotations (page {page}/{(total_count + limit - 1) // limit}) in dataset {dataset_id}")
        if all_annotations and page == 1:  # Only log sample IDs on first page
            sample_ids = [str(ann['id']) for ann in all_annotations[:5]]
            print(f"Sample annotation IDs: {sample_ids}")
        
        return {
            "success": True,
            "data": all_annotations,
            "pagination": {
                "page": page,
                "limit": limit,
                "total": total_count,
                "pages": (total_count + limit - 1) // limit
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_dataset_annotations_list: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get annotations: {str(e)}")


async def get_dataset_annotation_content(
    db: Session,
    dataset_id: int,
    annotation_id: str,
    *,
    include_images: bool = True,
    include_annotations: bool = True,
) -> dict:
    """Get the content of a specific annotation file with performance optimizations (database-only).

    Uses a fixed max inline size (not a ``limit`` query param) so clients cannot accidentally
    trigger the "large file" branch (e.g. ``?limit=100`` meant for another API).
    Fetches annotations in pages so files with >10k rows still return full COCO JSON.
    """
    # Max annotations we will ever stringify into one JSON payload for this endpoint.
    INLINE_CONTENT_MAX_ANNOTATIONS = 200_000
    FETCH_PAGE_SIZE = 10_000

    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Check if annotation file exists in database
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        live_annotation_count = (
            db.query(func.count(models.Annotation.id))
            .filter(models.Annotation.annotation_file_id == annotation_id)
            .scalar()
            or 0
        )

        # Import still running: avoid empty COCO + confusing client errors
        if (
            live_annotation_count == 0
            and annotation_file.processing_status in ("pending", "processing")
        ):
            return {
                "success": True,
                "data": {
                    "content": None,
                    "filename": annotation_file.name,
                    "format": "COCO",
                    "size": 0,
                    "source": "database",
                    "is_processing": True,
                    "processing_status": annotation_file.processing_status,
                    "message": "Annotation import is still processing. Wait until it completes, then open again.",
                },
            }

        # Too large to inline — use paginated /annotations/.../data from the client
        if live_annotation_count > INLINE_CONTENT_MAX_ANNOTATIONS:
            return {
                "success": True,
                "data": {
                    "content": None,
                    "filename": annotation_file.name,
                    "format": "COCO",
                    "size": 0,
                    "source": "database",
                    "is_large": True,
                    "total_annotations": live_annotation_count,
                    "message": (
                        f"This file has about {live_annotation_count:,} annotations — too many to download as one JSON file. "
                        "Open it in the segmentation editor: it loads each image from the database automatically."
                    ),
                },
            }
        
        # Generate COCO format from database with limited queries
        from app.services.annotation_processing import get_annotation_data, get_annotation_classes
        
        # Get classes first (usually small)
        classes_response = await get_annotation_classes(dataset_id, annotation_id, db)
        
        # Paginate through all annotations (direct router calls — not HTTP; page size can exceed 1000)
        all_annotation_rows: list = []
        page = 1
        annotations_response = None
        while True:
            annotations_response = await get_annotation_data(
                dataset_id, annotation_id, None, page, FETCH_PAGE_SIZE, None, db
            )
            if not annotations_response["success"]:
                raise HTTPException(status_code=500, detail="Failed to retrieve annotation data")
            chunk = annotations_response["data"]["annotations"]
            all_annotation_rows.extend(chunk)
            pagination = annotations_response["data"].get("pagination") or {}
            total_pages = int(pagination.get("pages") or 1)
            if page >= total_pages or not chunk:
                break
            page += 1
        
        if not classes_response["success"]:
            raise HTTPException(status_code=500, detail="Failed to retrieve annotation data")
        
        project_name = None
        if dataset.project_id:
            project = db.query(models.Project).filter(models.Project.id == dataset.project_id).first()
            project_name = project.name if project else None
        dataset_name = dataset.name or f"Dataset {dataset_id}"
        
        # Build COCO format efficiently
        coco_data = {
            "info": {
                "description": f"Annotations for dataset {dataset_name}",
                "version": "1.0",
                "year": datetime.utcnow().year,
                "contributor": "LAI",
                "date_created": annotation_file.created_at.isoformat() if annotation_file.created_at else None,
                "project_name": project_name,
                "dataset_name": dataset_name
            },
            "categories": [],
            "images": [],
            "annotations": []
        }
        
        # Add categories
        category_id_map = {}
        for i, cls in enumerate(classes_response["data"]["classes"]):
            category_id = cls.get("categoryId", i + 1)
            category_id_map[cls["className"]] = category_id
            coco_data["categories"].append({
                "id": category_id,
                "name": cls["className"],
                "supercategory": ""
            })
        
        # Process images and annotations more efficiently
        image_id_map = {}  # Initialize outside the if block
        if include_images or include_annotations:
            # Get unique image IDs from annotations to minimize image queries
            image_ids = set()
            for ann in all_annotation_rows:
                image_ids.add(ann["imageId"])
            
            # Batch load images
            if include_images and image_ids:
                images = db.query(models.Image).filter(
                    models.Image.id.in_(list(image_ids))
                ).all()
                
                for i, image in enumerate(images):
                    coco_image_id = i + 1
                    image_id_map[image.id] = coco_image_id
                    coco_data["images"].append({
                        "id": coco_image_id,
                        "file_name": image.file_name,
                        "width": image.width or 1,
                        "height": image.height or 1
                    })
            elif image_ids:
                # Load images even if not including in output, for bbox conversion
                images = db.query(models.Image).filter(
                    models.Image.id.in_(list(image_ids))
                ).all()
                
                for i, image in enumerate(images):
                    coco_image_id = i + 1
                    image_id_map[image.id] = coco_image_id
                    if include_images:
                        coco_data["images"].append({
                            "id": coco_image_id,
                            "file_name": image.file_name,
                            "width": image.width or 1,
                            "height": image.height or 1
                        })
            
            # Add annotations
            if include_annotations:
                # Build image dimension map for coordinate conversion
                image_dims = {}
                if image_ids:
                    afi_rows = db.query(models.AnnotationFileImage).filter(
                        models.AnnotationFileImage.annotation_file_id == annotation_id,
                        models.AnnotationFileImage.dataset_image_id.in_(list(image_ids)),
                    ).all()
                    for afi in afi_rows:
                        if afi.dataset_image_id and afi.width and afi.height:
                            image_dims[afi.dataset_image_id] = (afi.width, afi.height)
                    images_for_dims = db.query(models.Image).filter(
                        models.Image.id.in_(list(image_ids))
                    ).all()
                    for img in images_for_dims:
                        if img.id not in image_dims:
                            image_dims[img.id] = (img.width or 1, img.height or 1)
                
                for ann in all_annotation_rows:
                    image_id = ann["imageId"]
                    
                    # Get image dimensions for this annotation
                    img_width, img_height = image_dims.get(image_id, (1, 1))
                    if ann.get("imageWidth") and ann.get("imageHeight"):
                        img_width = ann["imageWidth"] or img_width
                        img_height = ann["imageHeight"] or img_height
                    
                    # Build base annotation (use primary key when cocoAnnotationId is null)
                    coco_ann = {
                        "id": ann.get("cocoAnnotationId") if ann.get("cocoAnnotationId") is not None else ann["id"],
                        "image_id": image_id_map.get(image_id, 1) if include_images else ann["imageId"],
                        "category_id": category_id_map.get(ann["className"], 1)
                    }

                    # Handle segmentation - coordinates are already stored as pixels.
                    # COCO expects either:
                    #   - polygon list: [[x1,y1,x2,y2,...], ...]
                    #   - RLE dict
                    # Stored data may be flat [x1,y1,...] or nested [[...]].
                    seg_raw = ann.get("segmentation")
                    if seg_raw:
                        if isinstance(seg_raw, dict):
                            # RLE payload
                            coco_ann["segmentation"] = seg_raw
                        elif isinstance(seg_raw, list):
                            first = seg_raw[0] if len(seg_raw) > 0 else None
                            if isinstance(first, (int, float)):
                                # Flat polygon -> wrap once for COCO polygon format
                                if len(seg_raw) >= 6:
                                    coco_ann["segmentation"] = [seg_raw]
                            else:
                                # Already polygon list; keep only valid polygons
                                valid_polys = [
                                    poly
                                    for poly in seg_raw
                                    if isinstance(poly, list) and len(poly) >= 6
                                ]
                                if valid_polys:
                                    coco_ann["segmentation"] = valid_polys

                    # Handle bbox — API rows are normalized 0–1; COCO JSON uses pixels
                    if ann.get("bbox") and len(ann["bbox"]) == 4:
                        bx, by, bw, bh = (float(v) for v in ann["bbox"][:4])
                        w_dim = float(img_width or 1) or 1.0
                        h_dim = float(img_height or 1) or 1.0
                        if max(bx, by, bw, bh) <= 1.0:
                            pixel_bbox = [bx * w_dim, by * h_dim, bw * w_dim, bh * h_dim]
                        else:
                            # Legacy rows stored absolute pixels in bbox columns
                            pixel_bbox = [bx, by, bw, bh]
                        coco_ann["bbox"] = pixel_bbox
                        stored_area = ann.get("area")
                        if stored_area is not None and stored_area <= 1.0:
                            coco_ann["area"] = float(stored_area) * w_dim * h_dim
                        else:
                            coco_ann["area"] = (
                                stored_area
                                if stored_area is not None
                                else (pixel_bbox[2] * pixel_bbox[3])
                            )
                        coco_ann["iscrowd"] = 0
                    elif coco_ann.get("segmentation"):
                        # Mask-only: ensure area/iscrowd and bbox from polygon bounds
                        coco_ann["area"] = ann.get("area") or 0
                        coco_ann["iscrowd"] = 0
                        if isinstance(coco_ann["segmentation"], list):
                            flat = [x for p in coco_ann["segmentation"] for x in p]
                            if len(flat) >= 4:
                                xs, ys = flat[0::2], flat[1::2]
                                min_x, max_x = min(xs), max(xs)
                                min_y, max_y = min(ys), max(ys)
                                coco_ann["bbox"] = [min_x, min_y, max_x - min_x, max_y - min_y]

                    coco_data["annotations"].append(coco_ann)
        
        content = json.dumps(coco_data, indent=2)
        
        return {
            "success": True,
            "data": {
                "content": content,
                "filename": annotation_file.name,
                "format": "COCO",
                "size": len(content),
                "source": "database",
                "is_large": False,
                "annotation_count": len(coco_data["annotations"]),
                "image_count": len(coco_data["images"]),
                "category_count": len(coco_data["categories"])
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in get_dataset_annotation_content: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get annotation content: {str(e)}")


async def duplicate_annotation_file(db: Session, dataset_id: int, annotation_id: str) -> dict:
    """Duplicate an annotation file with all its annotations (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Find the original annotation file
        original_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not original_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")
        
        # Generate unique name for the copy
        base_name = original_file.name.rsplit('.', 1)[0] if '.' in original_file.name else original_file.name
        extension = '.' + original_file.name.rsplit('.', 1)[1] if '.' in original_file.name else ''
        
        copy_index = 1
        new_name = f"{base_name}_copy{extension}"
        
        while db.query(models.AnnotationFile).filter(
            models.AnnotationFile.dataset_id == dataset_id,
            models.AnnotationFile.name == new_name
        ).first():
            copy_index += 1
            new_name = f"{base_name}_copy{copy_index}{extension}"
        
        # Create new annotation file entry
        import uuid
        new_file_id = str(uuid.uuid4())
        
        new_file = models.AnnotationFile(
            id=new_file_id,
            dataset_id=dataset_id,
            name=new_name,
            format=original_file.format,
            type=original_file.type,
            annotation_count=original_file.annotation_count,
            image_count=original_file.image_count,
            category_count=original_file.category_count,
            file_size=original_file.file_size,
            statistics=original_file.statistics,
            _tags=original_file.tags[:] if original_file.tags else [],
            processing_status="completed",
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        db.add(new_file)
        db.flush()
        
        # Copy all annotations
        original_annotations = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id
        ).all()
        
        for orig_ann in original_annotations:
            new_annotation = models.Annotation(
                annotation_file_id=new_file_id,
                image_id=orig_ann.image_id,
                dataset_id=dataset_id,
                category_id=orig_ann.category_id,
                category=orig_ann.category,
                segmentation=orig_ann.segmentation[:] if orig_ann.segmentation else None,
                bbox=orig_ann.bbox[:] if orig_ann.bbox else None,
                area=orig_ann.area
            )
            db.add(new_annotation)
        
        # Copy annotation classes
        original_classes = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id
        ).all()
        
        for orig_class in original_classes:
            new_class = models.AnnotationClass(
                annotation_file_id=new_file_id,
                class_name=orig_class.class_name,
                category_id=orig_class.category_id,
                count=orig_class.count,
                color=orig_class.color,
                opacity=orig_class.opacity
            )
            db.add(new_class)
        
        # Copy annotation file images mapping
        original_images = db.query(models.AnnotationFileImage).filter(
            models.AnnotationFileImage.annotation_file_id == annotation_id
        ).all()
        
        for orig_img in original_images:
            new_img = models.AnnotationFileImage(
                annotation_file_id=new_file_id,
                coco_image_id=orig_img.coco_image_id,
                file_name=orig_img.file_name,
                dataset_image_id=orig_img.dataset_image_id,
                width=orig_img.width,
                height=orig_img.height
            )
            db.add(new_img)
        
        db.commit()
        
        return {
            "success": True,
            "message": f"Annotation file duplicated successfully",
            "new_file_id": new_file_id,
            "new_file_name": new_name,
            "annotation_count": len(original_annotations)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in duplicate_annotation_file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to duplicate annotation file: {str(e)}")


async def rename_annotation_file(
    db: Session, dataset_id: int, annotation_id: str, new_name: str
) -> dict:
    """Rename an annotation file (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Find the annotation file in database
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(
                status_code=404,
                detail=f"Annotation file with ID '{annotation_id}' not found"
            )
        
        # Validate new name
        if not new_name.strip():
            raise HTTPException(status_code=400, detail="New filename cannot be empty")
        
        new_name = new_name.strip()
        
        # Check if new name already exists
        existing_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.name == new_name,
            models.AnnotationFile.dataset_id == dataset_id,
            models.AnnotationFile.id != annotation_id
        ).first()
        
        if existing_file:
            raise HTTPException(
                status_code=409, 
                detail=f"A file with the name '{new_name}' already exists"
            )
        
        # Update the name in database
        old_name = annotation_file.name
        annotation_file.name = new_name
        annotation_file.updated_at = datetime.utcnow()
        db.commit()
        
        return {
            "success": True,
            "message": f"Annotation file renamed from '{old_name}' to '{new_name}'",
            "old_filename": old_name,
            "new_filename": new_name,
            "display_name": new_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in rename_annotation_file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to rename annotation file: {str(e)}")


async def update_annotation_tags(
    db: Session, dataset_id: int, annotation_id: str, tags: List[str]
) -> dict:
    """Update tags for an annotation file (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Find the annotation file in database
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(
                status_code=404,
                detail=f"Annotation file with ID '{annotation_id}' not found"
            )
        
        # Update tags
        annotation_file.tags = tags
        annotation_file.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(annotation_file)
        
        return {
            "success": True,
            "message": f"Tags updated for annotation file '{annotation_file.name}'",
            "tags": annotation_file.tags
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in update_annotation_tags: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update annotation tags: {str(e)}")


async def update_annotation_content(
    db: Session, dataset_id: int, annotation_id: str, file: UploadFile
) -> dict:
    """Update the content of an existing annotation file (database-only)"""
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        # Find the annotation file in database
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(
                status_code=404,
                detail=f"Annotation file with ID '{annotation_id}' not found"
            )

        # Read and validate uploaded content
        contents = await file.read()
        content_str = contents.decode('utf-8')
        
        # Validate JSON format
        try:
            content_json = json.loads(content_str)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON format: {str(e)}")
        
        # Update annotation file metadata based on new content
        annotation_count = len(content_json.get('annotations', []))
        image_count = len(content_json.get('images', []))
        category_count = len(content_json.get('categories', []))
        
        # Extract statistics if provided in the uploaded content
        statistics = content_json.get('statistics', None)
        
        # Let process_coco_annotation_file clear and re-insert annotations (it uses its own
        # session and commit). Do not delete here or the main session's commit would wipe
        # the data that process_coco_annotation_file just wrote.
        from app.services.annotation_processing import process_coco_annotation_file
        await process_coco_annotation_file(
            annotation_id, content_json
        )
        
        # Update annotation file metadata
        annotation_file.annotation_count = annotation_count
        annotation_file.image_count = image_count
        annotation_file.category_count = category_count
        annotation_file.file_size = len(contents)
        annotation_file.statistics = statistics  # Save statistics to database
        annotation_file.updated_at = datetime.utcnow()
        
        db.commit()
        
        return {
            "success": True,
            "message": f"Annotation file '{annotation_file.name}' updated successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in update_annotation_content: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update annotation content: {str(e)}")


async def rename_annotation_class(db: Session, dataset_id: int, annotation_id: str,
    body: dict
):
    """Rename a class in an annotation file (updates all annotations and class stats). Used by both Dataset annotations view and Edit Dataset."""
    old_class_name = (body.get("old_class_name") or body.get("oldClassName") or "").strip()
    new_class_name = (body.get("new_class_name") or body.get("newClassName") or "").strip()
    if not old_class_name or not new_class_name:
        raise HTTPException(status_code=400, detail="old_class_name and new_class_name required")
    if old_class_name == new_class_name:
        return {"success": True, "message": "No change"}

    try:
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        if not annotation_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        # Update all annotations: category old -> new
        updated = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id,
            models.Annotation.category == old_class_name
        ).update({"category": new_class_name}, synchronize_session=False)

        # Update or merge AnnotationClass
        old_class = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id,
            models.AnnotationClass.class_name == old_class_name
        ).first()
        new_class = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id,
            models.AnnotationClass.class_name == new_class_name
        ).first()
        if old_class:
            if new_class:
                new_class.count = (new_class.count or 0) + (old_class.count or 0)
                db.delete(old_class)
            else:
                old_class.class_name = new_class_name
        # if no old_class, nothing to rename

        annotation_file.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(annotation_file)
        # Return updated class list so frontend can show correct counts (avoid 0/NaN%)
        classes = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id
        ).all()
        classes_data = [
            {
                "className": c.class_name,
                "count": c.count if c.count is not None else 0,
                "color": c.color or "#ea384c",
                "opacity": c.opacity if c.opacity is not None else 0.25,
                "categoryId": c.category_id,
            }
            for c in classes
        ]
        return {
            "success": True,
            "message": f"Renamed class '{old_class_name}' to '{new_class_name}'",
            "annotations_updated": updated,
            "classes": classes_data,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in rename_annotation_class: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def delete_annotation_class(db: Session, dataset_id: int, annotation_id: str,
    class_name: str
):
    """Delete all annotations for a specific class from an annotation file"""
    try:
        # Validate annotation file exists
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        # Debug: Check what classes exist
        existing_annotations = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id
        ).all()
        unique_categories = set(ann.category for ann in existing_annotations if ann.category)
        print(f"DEBUG: Attempting to delete class '{class_name}' from annotation file '{annotation_id}'")
        print(f"DEBUG: Existing categories in file: {unique_categories}")
        print(f"DEBUG: Total annotations in file: {len(existing_annotations)}")
        
        # Delete annotations with this class/category
        deleted_count = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id,
            models.Annotation.category == class_name
        ).delete(synchronize_session=False)
        
        print(f"DEBUG: Deleted {deleted_count} annotations")
        
        # Delete the class entry itself
        db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id,
            models.AnnotationClass.class_name == class_name
        ).delete(synchronize_session=False)
        
        # Update annotation file metadata
        remaining_annotation_count = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id
        ).count()
        
        remaining_category_count = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id
        ).count()
        
        annotation_file.annotation_count = remaining_annotation_count
        annotation_file.category_count = remaining_category_count
        annotation_file.updated_at = datetime.utcnow()
        
        db.commit()
        
        return {
            "success": True,
            "message": f"Deleted {deleted_count} annotations for class '{class_name}'",
            "deleted_count": deleted_count,
            "remaining_annotations": remaining_annotation_count,
            "remaining_categories": remaining_category_count
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in delete_annotation_class: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete class: {str(e)}")


async def update_single_image_annotations(db: Session, dataset_id: int, annotation_id: str,
    image_name: str,
    request: dict
):
    """Update annotations for a single image within an annotation file"""
    try:
        # Validate annotation file exists
        annotation_file = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id == annotation_id,
            models.AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            raise HTTPException(status_code=404, detail="Annotation file not found")

        request_collection_id_raw = request.get("collection_id")
        request_collection_id = None
        if request_collection_id_raw is not None:
            try:
                request_collection_id = int(request_collection_id_raw)
            except (TypeError, ValueError):
                request_collection_id = None

        # Find the image by filename. Use the shared resolver so save and load
        # paths always agree on which `images` row to target when multiple
        # collections share a filename (see annotation_db.resolve_dataset_image_by_filename).
        from app.services.annotation_processing import resolve_dataset_image_by_filename
        image = resolve_dataset_image_by_filename(
            db,
            dataset_id,
            image_name,
            preferred_collection_id=request_collection_id,
        )

        if not image:
            raise HTTPException(status_code=404, detail=f"Image '{image_name}' not found in dataset")

        # Get the annotations for this specific image from request
        image_annotations = request.get('annotations', [])
        image_width = request.get('image_width', 0)
        image_height = request.get('image_height', 0)
        
        # Get existing AnnotationClass entries and build a map for category_id lookup
        existing_classes = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id
        ).all()
        class_name_to_category_id = {cls.class_name: cls.category_id for cls in existing_classes}
        
        # Find the max category_id to assign to new classes
        max_category_id = max([cls.category_id or 0 for cls in existing_classes], default=0)
        
        # Delete existing annotations for this image and annotation file
        deleted_count = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id,
            models.Annotation.image_id == image.id
        ).delete()
        
        # Track new classes that need to be added
        new_classes_to_add = {}
        
        # Insert new annotations for this image
        annotation_count = 0
        for ann_data in image_annotations:
            category_name = ann_data.get('category_name', '')
            
            # Determine the correct category_id
            if category_name in class_name_to_category_id:
                # Use existing category_id from database
                category_id = class_name_to_category_id[category_name]
            elif category_name in new_classes_to_add:
                # Use the category_id we assigned for this new class
                category_id = new_classes_to_add[category_name]
            else:
                # This is a new class - assign a new category_id
                max_category_id += 1
                category_id = max_category_id
                new_classes_to_add[category_name] = category_id
                class_name_to_category_id[category_name] = category_id
            
            annotation = models.Annotation(
                annotation_file_id=annotation_id,
                image_id=image.id,
                dataset_id=dataset_id,
                category_id=category_id,
                category=category_name,
                segmentation=ann_data.get('segmentation', []),
                bbox=ann_data.get('bbox', []),
                area=ann_data.get('area', 0.0)
            )
            db.add(annotation)
            annotation_count += 1
        
        # Add new classes to AnnotationClass table
        for class_name, category_id in new_classes_to_add.items():
            new_class = models.AnnotationClass(
                annotation_file_id=annotation_id,
                class_name=class_name,
                category_id=category_id,
                count=0,  # Will be updated below
                color='#ea384c',  # Default color
                opacity=0.25
            )
            db.add(new_class)
        
        # Flush changes to make new annotations and classes visible to subsequent queries
        db.flush()
        
        # Recompute statistics for this annotation file after update
        all_annotations = db.query(models.Annotation).filter(
            models.Annotation.annotation_file_id == annotation_id
        ).all()
        
        # Calculate statistics by class
        statistics = {}
        class_areas = {}
        class_counts = {}
        
        for ann in all_annotations:
            class_name = ann.category
            if class_name:
                class_counts[class_name] = class_counts.get(class_name, 0) + 1
                class_areas[class_name] = class_areas.get(class_name, 0) + (ann.area or 0)
        
        # Build statistics dictionary
        for class_name, count in class_counts.items():
            avg_area = class_areas[class_name] / count if count > 0 else 0
            statistics[class_name] = {
                "count": count,
                "avgArea": avg_area
            }
        
        # Update AnnotationClass counts based on actual annotation counts
        all_classes = db.query(models.AnnotationClass).filter(
            models.AnnotationClass.annotation_file_id == annotation_id
        ).all()
        classes_to_remove = []
        for cls in all_classes:
            cls.count = class_counts.get(cls.class_name, 0)
            if cls.count <= 0:
                classes_to_remove.append(cls.class_name)
        for class_name in classes_to_remove:
            db.query(models.AnnotationClass).filter(
                models.AnnotationClass.annotation_file_id == annotation_id,
                models.AnnotationClass.class_name == class_name
            ).delete()
        
        # Update annotation file with new statistics and timestamp
        annotation_file.statistics = statistics
        annotation_file.category_count = len(class_counts)
        annotation_file.updated_at = datetime.utcnow()

        from app.services.annotation_processing import detect_annotation_type_from_db_annotations
        detected_type = detect_annotation_type_from_db_annotations(all_annotations)
        if detected_type:
            annotation_file.type = detected_type

        annotated_image_count = db.query(
            func.count(func.distinct(models.Annotation.image_id))
        ).filter(
            models.Annotation.annotation_file_id == annotation_id,
            models.Annotation.image_id.isnot(None),
        ).scalar() or 0
        annotation_file.image_count = int(annotated_image_count)
        
        db.commit()
        
        return {
            "success": True,
            "message": f"Updated {annotation_count} annotations for image '{image_name}' (deleted {deleted_count} old annotations)",
            "image_name": image_name,
            "annotations_added": annotation_count,
            "annotations_removed": deleted_count,
            "statistics": statistics
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"Error in update_single_image_annotations: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to update image annotations: {str(e)}")