from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request, BackgroundTasks
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import Optional, List
import json
from pathlib import Path
import os
import logging
from datetime import datetime
import shutil

from .. import models, schemas
from ..database import get_db
from ..http_utils import public_request_base_url
from app.services.dataset_paths import (
    apply_storage_url_rewrite_for_project_move,
    filesystem_relocate_dataset_tree,
)
from app.services.dataset_media_service import (
    create_thumbnail_base64,
    set_random_image_as_logo,
)
from app.services.dataset_service import (
    create_duplication_task,
    dispatch_dataset_duplication,
    duplication_started_response,
    move_dataset_to_project,
)
from app.services.dataset_video_service import video_progress_get, video_progress_set

from app.services.dataset_schemas import (
    MergeAnnotationFilesRequest,
    MoveDatasetRequest,
    ViewFiftyOneRequest,
)
from app.services.dataset_images_service import (
    delete_dataset_image,
    list_dataset_images,
    upload_dataset_images,
)
from app.services.dataset_video_extract_service import extract_frames_from_video_service
from app.services import dataset_annotations_service as ann_svc
from app.services.dataset_annotation_merge_service import start_annotation_merge
from app.services.dataset_fiftyone_service import view_annotations_in_fiftyone

router = APIRouter()
logger = logging.getLogger(__name__)

_apply_storage_url_rewrite_for_project_move = apply_storage_url_rewrite_for_project_move
_filesystem_relocate_dataset_tree = filesystem_relocate_dataset_tree
_video_progress_get = video_progress_get
_create_thumbnail = create_thumbnail_base64
_set_random_image_as_logo = set_random_image_as_logo


@router.post("/datasets/", response_model=schemas.Dataset)
async def create_dataset(
    name: str = Form(...),
    description: str | None = Form(None),
    project_id: int = Form(...),
    tags: Optional[str] = Form(None),
    logo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    try:
        parsed_tags = json.loads(tags) if tags else []
        dataset_data = {
            "name": name,
            "description": description,
            "project_id": project_id,
            "tags": json.dumps(parsed_tags)
        }
        db_dataset = models.Dataset(**dataset_data)
        if logo:
            logo_data = await logo.read()
            db_dataset.logo = logo_data  # Store full image in binary field
            mime_type = logo.content_type or "image/png"
            
            # Create optimized thumbnail instead of storing full base64
            thumbnail_url = _create_thumbnail(logo_data, mime_type, max_size=(200, 200))
            db_dataset.thumbnailUrl = thumbnail_url
            db_dataset.logo_url = thumbnail_url  # Use thumbnail for logo_url too
        db.add(db_dataset)
        db.commit()
        db.refresh(db_dataset)
        return db_dataset
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/datasets/", response_model=List[schemas.Dataset])
def read_datasets(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
        
    datasets = db.query(models.Dataset).offset(skip).limit(limit).all()
    
    if not datasets:
        return []
    
    # Get all dataset IDs
    dataset_ids = [d.id for d in datasets]
    
    # Efficient batch count queries
    annotation_counts = dict(
        db.query(
            models.Annotation.dataset_id,
            func.count(models.Annotation.id)
        ).filter(
            models.Annotation.dataset_id.in_(dataset_ids)
        ).group_by(models.Annotation.dataset_id).all()
    )
    
    annotation_file_counts = dict(
        db.query(
            models.AnnotationFile.dataset_id,
            func.count(models.AnnotationFile.id)
        ).filter(
            models.AnnotationFile.dataset_id.in_(dataset_ids)
        ).group_by(models.AnnotationFile.dataset_id).all()
    )
    
    # Return datasets with corrected annotation counts
    result = []
    for dataset in datasets:
        result.append({
            "id": dataset.id,
            "name": dataset.name,
            "description": dataset.description,
            "tags": dataset.tags,
            "created_at": dataset.created_at,
            "updated_at": dataset.updated_at,
            "image_count": dataset.image_count,
            "annotation_count": annotation_counts.get(dataset.id, 0),
            "annotation_file_count": annotation_file_counts.get(dataset.id, 0),
            "project_id": dataset.project_id,
            "thumbnailUrl": dataset.thumbnailUrl,
            "logo_url": dataset.logo_url,
            "url": dataset.url
        })
    return result


@router.get("/datasets/{dataset_id}", response_model=schemas.Dataset)
def read_dataset(dataset_id: int, request: Request, db: Session = Depends(get_db)):
        
    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    # Set random image as logo if no logo is set and images exist
    base_url = public_request_base_url(request)
    _set_random_image_as_logo(dataset, db, base_url)
    # Refresh to get updated logo
    db.refresh(dataset)
    
    # Efficient count queries
    annotation_count = db.query(func.count(models.Annotation.id)).filter(
        models.Annotation.dataset_id == dataset_id
    ).scalar() or 0
    
    annotation_file_count = db.query(func.count(models.AnnotationFile.id)).filter(
        models.AnnotationFile.dataset_id == dataset_id
    ).scalar() or 0
    
    # Return dataset with corrected annotation count
    return {
        "id": dataset.id,
        "name": dataset.name,
        "description": dataset.description,
        "tags": dataset.tags,
        "created_at": dataset.created_at,
        "updated_at": dataset.updated_at,
        "image_count": dataset.image_count,
        "annotation_count": annotation_count,
        "annotation_file_count": annotation_file_count,
        "project_id": dataset.project_id,
        "thumbnailUrl": dataset.thumbnailUrl,
        "logo_url": dataset.logo_url,
        "url": dataset.url
    }


@router.put("/datasets/{dataset_id}", response_model=schemas.Dataset)
async def update_dataset(
    dataset_id: int,
    name: str = Form(...),
    description: str | None = Form(None),
    tags: Optional[str] = Form(None),
    project_id: Optional[int] = Form(None),
    logo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    filesystem_moved = False
    put_old_pid: Optional[int] = None
    put_new_pid: Optional[int] = None
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found")
        old_project_id = dataset.project_id
        if tags:
            dataset.tags = json.loads(tags)
        dataset.name = name
        dataset.description = description
        if project_id is not None and project_id != old_project_id:
            target_project = db.query(models.Project).filter(models.Project.id == project_id).first()
            if target_project is None:
                raise HTTPException(status_code=404, detail="Target project not found")
            moved_id_put = int(dataset_id)
            new_pid_put = int(project_id)
            if old_project_id is not None:
                did_move_put, fs_err_put = _filesystem_relocate_dataset_tree(
                    int(old_project_id),
                    new_pid_put,
                    moved_id_put,
                )
                if fs_err_put:
                    code = (
                        409 if "already exists" in fs_err_put.lower() else 500
                    )
                    raise HTTPException(status_code=code, detail=fs_err_put)
                if did_move_put:
                    filesystem_moved = True
                    put_old_pid = int(old_project_id)
                    put_new_pid = new_pid_put
            dataset.project_id = new_pid_put

            if old_project_id is not None:
                _apply_storage_url_rewrite_for_project_move(
                    db,
                    dataset,
                    dataset_id=moved_id_put,
                    old_project_id=int(old_project_id),
                    new_project_id=new_pid_put,
                )

            # Keep dataset groups consistent in the source project.
            if old_project_id is not None:
                groups = db.query(models.DatasetGroup).filter(
                    models.DatasetGroup.project_id == old_project_id
                ).all()
                for group in groups:
                    ids = group.datasets_list or []
                    if moved_id_put in ids:
                        group.datasets_list = [x for x in ids if int(x) != moved_id_put]
        if logo:
            logo_data = await logo.read()
            dataset.logo = logo_data  # Store full image in binary field
            mime_type = logo.content_type or "image/png"
            
            # Create optimized thumbnail instead of storing full base64
            thumbnail_url = _create_thumbnail(logo_data, mime_type, max_size=(200, 200))
            dataset.thumbnailUrl = thumbnail_url
            dataset.logo_url = thumbnail_url  # Use thumbnail for logo_url too
        db.commit()
        db.refresh(dataset)
        
        # Get annotation counts before detaching from session
        annotation_count = dataset.actual_annotation_count
        annotation_file_count = dataset.actual_annotation_file_count
        
        # Return a properly formatted response
        # Exclude base64 thumbnails from response to prevent hanging with large images
        # The thumbnail is small (200x200, ~10-20KB) but we still exclude it for consistency
        # Frontend can fetch it separately if needed, or we can include it since it's optimized
        return schemas.Dataset(
            id=dataset.id,
            name=dataset.name,
            description=dataset.description,
            tags=dataset.tags,
            created_at=dataset.created_at,
            updated_at=dataset.updated_at,
            image_count=dataset.image_count,
            annotation_count=annotation_count,
            annotation_file_count=annotation_file_count,
            annotation_files=[],  # Empty list to avoid serialization issues
            project_id=dataset.project_id,
            # Include thumbnail since it's now optimized (200x200, ~10-20KB max)
            thumbnailUrl=dataset.thumbnailUrl,
            logo_url=dataset.logo_url,
            url=dataset.url
        )
    except HTTPException as exc:
        db.rollback()
        if filesystem_moved and put_old_pid is not None and put_new_pid is not None:
            _, rev_put = _filesystem_relocate_dataset_tree(
                put_new_pid, put_old_pid, int(dataset_id)
            )
            if rev_put:
                logger.critical(
                    "update_dataset rollback: could not reverse filesystem move for dataset_id=%s: %s",
                    dataset_id,
                    rev_put,
                )
        raise exc
    except Exception as e:
        db.rollback()
        if filesystem_moved and put_old_pid is not None and put_new_pid is not None:
            _, rev_put = _filesystem_relocate_dataset_tree(
                put_new_pid, put_old_pid, int(dataset_id)
            )
            if rev_put:
                logger.critical(
                    "update_dataset rollback: could not reverse filesystem move for dataset_id=%s: %s",
                    dataset_id,
                    rev_put,
                )
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/datasets/{dataset_id}/augmented-datasets")
async def get_augmented_datasets(dataset_id: int, db: Session = Depends(get_db)):
    """
    Get datasets that were created by augmenting this dataset.
    """
    try:
        # Find augmentations where this dataset was a source
        augmentations = db.query(models.Augmentation).all()
        augmented_dataset_ids = []
        
        for aug in augmentations:
            if aug.source_dataset_ids and dataset_id in aug.source_dataset_ids:
                if aug.target_dataset_id:
                    augmented_dataset_ids.append(aug.target_dataset_id)
        
        # Get the actual datasets
        augmented_datasets = []
        for ds_id in augmented_dataset_ids:
            ds = db.query(models.Dataset).filter(models.Dataset.id == ds_id).first()
            if ds:
                augmented_datasets.append({
                    "id": ds.id,
                    "name": ds.name,
                    "description": ds.description
                })
        
        return {
            "augmented_datasets": augmented_datasets,
            "count": len(augmented_datasets)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/datasets/{dataset_id}")
async def delete_dataset(
    dataset_id: int, 
    delete_augmented: bool = False,
    db: Session = Depends(get_db)
):
    """
    Delete a dataset and all its associated data.
    This removes both the database records and all physical files.
    
    Args:
        dataset_id: ID of the dataset to delete
        delete_augmented: If True, also delete datasets that were created by augmenting this one
    """
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        project_id = dataset.project_id
        datasets_to_delete = [dataset_id]
        
        # If delete_augmented is True, find and include augmented datasets
        if delete_augmented:
            augmentations = db.query(models.Augmentation).all()
            for aug in augmentations:
                if aug.source_dataset_ids and dataset_id in aug.source_dataset_ids:
                    if aug.target_dataset_id and aug.target_dataset_id not in datasets_to_delete:
                        datasets_to_delete.append(aug.target_dataset_id)
        
        # Delete each dataset
        for ds_id in datasets_to_delete:
            ds = db.query(models.Dataset).filter(models.Dataset.id == ds_id).first()
            if not ds:
                continue
                
            # Delete physical files
            try:
                ds_project_id = ds.project_id
                
                # Delete from new projects structure
                dataset_dir = Path("projects") / str(ds_project_id) / str(ds_id)
                if dataset_dir.exists():
                    shutil.rmtree(dataset_dir)
                    print(f"Deleted dataset directory: {dataset_dir}")
                
                # Also check old data structure for backward compatibility
                old_images_dir = Path("data/images") / str(ds_id)
                old_annotations_dir = Path("data/annotations") / str(ds_id)
                
                if old_images_dir.exists():
                    shutil.rmtree(old_images_dir)
                
                if old_annotations_dir.exists():
                    shutil.rmtree(old_annotations_dir)
                    
            except Exception as file_error:
                print(f"Warning: Could not delete some physical files for dataset {ds_id}: {file_error}")
            
            from ..db_cleanup import delete_dataset_record

            delete_dataset_record(db, ds)
        
        db.commit()
        
        deleted_count = len(datasets_to_delete)
        return {
            "success": True,
            "message": f"Successfully deleted {deleted_count} dataset(s)",
            "deleted_count": deleted_count,
            "deleted_ids": datasets_to_delete
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        import traceback
        print(f"Error deleting dataset: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/datasets/{dataset_id}/duplicate")
async def duplicate_dataset(dataset_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Start a background task to duplicate a dataset with all its associated data:
    - Dataset metadata
    - Image collections
    - Images (database records and physical files)
    - Annotation files (database records and physical files)
    - Annotations
    - Annotation classes
    
    Returns immediately with a task ID that can be used to track progress.
    """
    try:
        use_celery = os.environ.get("USE_CELERY", "true").lower() == "true"

        original_dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if original_dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found")

        task = create_duplication_task(db, original_dataset, dataset_id)
        mode, result = dispatch_dataset_duplication(
            db, task, dataset_id, use_celery=use_celery
        )

        if mode == "async":
            return duplication_started_response(task)

        new_dataset_id = (result or {}).get("new_dataset_id")
        new_dataset = db.query(models.Dataset).filter(models.Dataset.id == new_dataset_id).first()
        return new_dataset

    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/datasets/{dataset_id}/move", response_model=schemas.Dataset)
async def move_dataset(
    dataset_id: int,
    req: MoveDatasetRequest,
    db: Session = Depends(get_db),
):
    """
    Move a dataset to another project: updates DB, rewrites static image URLs,
    and physically relocates ``projects/<old_project>/<dataset_id>/`` (entire tree)
    under the target project folder when ``old_project_id`` is known and the tree exists.
    """
    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    return move_dataset_to_project(db, dataset, target_project_id=req.project_id)

@router.post("/datasets/{dataset_id}/images")
async def upload_images(
    request: Request,
    dataset_id: int,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    return await upload_dataset_images(
        db, dataset_id, files, public_request_base_url(request)
    )


@router.post("/datasets/{dataset_id}/video-extract")
async def extract_frames_from_video(
    request: Request,
    dataset_id: int,
    video: UploadFile = File(...),
    interval_seconds: float = Form(1.0),
    frame_step: int = Form(1),
    max_frames: int = Form(0),
    job_id: str = Form(""),
    collection_id: Optional[int] = Form(None),
    sequential_names: bool = Form(False),
    resize_width: int = Form(0),
    resize_height: int = Form(0),
    db: Session = Depends(get_db),
):
    return await extract_frames_from_video_service(
        db,
        dataset_id,
        video,
        public_request_base_url(request),
        interval_seconds=interval_seconds,
        frame_step=frame_step,
        max_frames=max_frames,
        job_id=job_id,
        collection_id=collection_id,
        sequential_names=sequential_names,
        resize_width=resize_width,
        resize_height=resize_height,
    )


@router.get("/datasets/{dataset_id}/video-extract/progress/{job_id}")
def get_video_extract_progress(dataset_id: int, job_id: str):
    entry = _video_progress_get(job_id)
    if entry is None:
        return {
            "success": True,
            "data": {
                "job_id": job_id,
                "stage": "unknown",
                "extracted": 0,
                "total": 0,
                "percent": 0.0,
            },
        }
    if entry.get("dataset_id") not in (None, dataset_id):
        raise HTTPException(status_code=404, detail="Job does not belong to this dataset")
    return {"success": True, "data": entry}


@router.get("/datasets/{dataset_id}/images")
def get_dataset_images(request: Request, dataset_id: int, db: Session = Depends(get_db)):
    return list_dataset_images(db, dataset_id, public_request_base_url(request))


@router.delete("/datasets/{dataset_id}/images/{image_id}")
async def delete_image(dataset_id: int, image_id: int, db: Session = Depends(get_db)):
    return await delete_dataset_image(db, dataset_id, image_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/coverage")
def get_annotation_file_coverage(
    dataset_id: int, annotation_file_id: str, db: Session = Depends(get_db)
):
    return ann_svc.get_annotation_file_coverage(db, dataset_id, annotation_file_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/collection-counts")
def get_annotation_file_collection_counts(
    dataset_id: int, annotation_file_id: str, db: Session = Depends(get_db)
):
    return ann_svc.get_annotation_file_collection_counts(db, dataset_id, annotation_file_id)


@router.get("/datasets/{dataset_id}/annotations/coverage")
def get_dataset_annotations_coverage(dataset_id: int, db: Session = Depends(get_db)):
    return ann_svc.get_dataset_annotations_coverage(db, dataset_id)


@router.post("/datasets/{dataset_id}/import-annotations")
async def import_annotations(
    dataset_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.import_annotations(db, dataset_id, background_tasks, file)


@router.post("/datasets/{dataset_id}/create-annotation-task")
async def create_annotation_processing_task(
    dataset_id: int,
    file: UploadFile = File(...),
    annotation_type: Optional[str] = Form(None),
    task_name: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    return await ann_svc.create_annotation_processing_task(
        db, dataset_id, file, annotation_type, task_name
    )


@router.delete("/datasets/{dataset_id}/annotations/{annotation_id}")
async def delete_dataset_annotation(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.delete_dataset_annotation(db, dataset_id, annotation_id)


@router.get("/datasets/{dataset_id}/annotations")
async def get_dataset_annotations(dataset_id: int, db: Session = Depends(get_db)):
    return await ann_svc.get_dataset_annotations(db, dataset_id)


@router.get("/datasets/{dataset_id}/annotations/{annotation_id}")
async def get_dataset_annotation(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.get_dataset_annotation(db, dataset_id, annotation_id)


@router.get("/datasets/{dataset_id}/annotations/summary")
async def get_dataset_annotations_summary(dataset_id: int, db: Session = Depends(get_db)):
    return await ann_svc.get_dataset_annotations_summary(db, dataset_id)


@router.get("/datasets/{dataset_id}/annotations/list")
async def get_dataset_annotations_list(
    dataset_id: int,
    page: int = 1,
    limit: int = 1000,
    annotation_file_id: Optional[str] = None,
    db: Session = Depends(get_db),
):
    return await ann_svc.get_dataset_annotations_list(
        db, dataset_id, page, limit, annotation_file_id
    )


@router.get("/datasets/{dataset_id}/annotations/{annotation_id}/content")
async def get_dataset_annotation_content(
    dataset_id: int,
    annotation_id: str,
    include_images: bool = True,
    include_annotations: bool = True,
    db: Session = Depends(get_db),
):
    return await ann_svc.get_dataset_annotation_content(
        db,
        dataset_id,
        annotation_id,
        include_images=include_images,
        include_annotations=include_annotations,
    )


@router.post("/datasets/{dataset_id}/annotations/{annotation_id}/duplicate")
async def duplicate_annotation_file(
    dataset_id: int, annotation_id: str, db: Session = Depends(get_db)
):
    return await ann_svc.duplicate_annotation_file(db, dataset_id, annotation_id)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/rename")
async def rename_annotation_file(
    dataset_id: int,
    annotation_id: str,
    new_name: str = Form(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.rename_annotation_file(db, dataset_id, annotation_id, new_name)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/tags")
async def update_annotation_tags(
    dataset_id: int,
    annotation_id: str,
    tags: List[str] = Form(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.update_annotation_tags(db, dataset_id, annotation_id, tags)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/content")
async def update_annotation_content(
    dataset_id: int,
    annotation_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    return await ann_svc.update_annotation_content(db, dataset_id, annotation_id, file)


@router.put("/datasets/{dataset_id}/annotations/{annotation_id}/class/rename")
async def rename_annotation_class(
    dataset_id: int, annotation_id: str, body: dict, db: Session = Depends(get_db)
):
    return await ann_svc.rename_annotation_class(db, dataset_id, annotation_id, body)


@router.delete("/datasets/{dataset_id}/annotations/{annotation_id}/class/{class_name}")
async def delete_annotation_class(
    dataset_id: int, annotation_id: str, class_name: str, db: Session = Depends(get_db)
):
    return await ann_svc.delete_annotation_class(db, dataset_id, annotation_id, class_name)


@router.patch("/datasets/{dataset_id}/annotations/{annotation_id}/image/{image_name}")
async def update_single_image_annotations(
    dataset_id: int,
    annotation_id: str,
    image_name: str,
    request: dict,
    db: Session = Depends(get_db),
):
    return await ann_svc.update_single_image_annotations(
        db, dataset_id, annotation_id, image_name, request
    )


@router.post("/datasets/{dataset_id}/annotations/merge")
async def merge_annotation_files(
    dataset_id: int,
    request: MergeAnnotationFilesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return await start_annotation_merge(db, dataset_id, request, background_tasks)


@router.post("/datasets/{dataset_id}/annotations/view-fiftyone")
async def view_annotations_in_fiftyone_endpoint(
    dataset_id: int,
    body: ViewFiftyOneRequest,
    db: Session = Depends(get_db),
):
    return await view_annotations_in_fiftyone(db, dataset_id, body)
