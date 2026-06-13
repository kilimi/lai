from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import Optional, List
from pydantic import BaseModel
import json
from pathlib import Path
import shutil
import sys
import re

from .. import models, schemas
from ..database import get_db
from ..db_cleanup import delete_project_record
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.services.dataset_media_service import (
    create_thumbnail_base64,
    truncate_base64_url,
)

router = APIRouter()


class MergeDatasetsRequest(BaseModel):
    name: str
    dataset_ids: List[int]


@router.post("/projects/")
async def create_project(
    name: str = Form(...),
    description: str = Form(""),
    tags: Optional[str] = Form(None),
    logo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    try:
        parsed_tags = json.loads(tags) if tags else []
        project_data = {
            "name": name,
            "description": description,
            "tags": json.dumps(parsed_tags)
        }
        db_project = models.Project(**project_data)
        if logo:
            logo_data = await logo.read()
            db_project.logo = logo_data
            mime_type = logo.content_type or "image/png"
            # Generate thumbnail for faster loading in list view
            thumbnail_url = create_thumbnail_base64(logo_data, mime_type)
            db_project.logo_url = thumbnail_url
        db.add(db_project)
        db.commit()
        db.refresh(db_project)
        return {
            "success": True,
            "data": {
                "id": db_project.id,
                "name": db_project.name,
                "description": db_project.description,
                "tags": db_project.tags,
                "created_at": db_project.created_at.isoformat(),
                "updated_at": db_project.updated_at.isoformat(),
                "logo_url": db_project.logo_url
            }
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/projects/", response_model=list[schemas.Project])
def read_projects(skip: int = 0, limit: int = 100, include_images: bool = True, db: Session = Depends(get_db)):
    """
    Get all projects with minimal dataset info for fast loading.
    Only returns basic project info and dataset counts.
    
    Thumbnails are now included by default since they're optimized (200x200, JPEG, 85% quality).
    Set include_images=false to exclude them if needed.
    """
    try:
        from sqlalchemy import func
        from sqlalchemy.orm import selectinload, load_only
        
        # Use eager loading with load_only to fetch minimal dataset fields
        # Exclude large base64 thumbnail/logo fields to dramatically reduce payload size
        dataset_fields = [
            models.Dataset.id,
            models.Dataset.name,
            models.Dataset.description,
            models.Dataset.image_count,
            models.Dataset.project_id,
            models.Dataset.created_at,
            models.Dataset.updated_at
        ]
        # NOTE: Intentionally NOT loading logo_url/thumbnailUrl for datasets
        # These can be 5-10MB each and are not displayed in the projects list view
        
        projects = db.query(models.Project).options(
            selectinload(models.Project.datasets).load_only(*dataset_fields)
        ).offset(skip).limit(limit).all()
        
        result = []
        for p in projects:
            # Serialize datasets with minimal info (no annotation counts/files)
            # EXCLUDE thumbnailUrl and logo_url from datasets in list view - they can be very large
            # and are not displayed in the projects list view anyway
            datasets = []
            if p.datasets:
                for dataset in p.datasets:
                    datasets.append({
                        "id": dataset.id,
                        "name": dataset.name,
                        "description": dataset.description,
                        "tags": [],  # Skip tags for list view
                        "created_at": dataset.created_at,
                        "updated_at": dataset.updated_at,
                        "image_count": dataset.image_count,
                        "annotation_count": 0,  # Not needed for list view
                        "annotation_file_count": 0,  # Not needed for list view
                        "annotation_files": [],  # Not needed for list view
                        "project_id": dataset.project_id,
                        "thumbnailUrl": None,  # Exclude to reduce payload size
                        "logo_url": None,  # Exclude to reduce payload size
                        "url": None
                    })
            
            # Only include base64 project logo if explicitly requested
            project_logo_url = truncate_base64_url(p.logo_url, include_images)
            
            result.append({
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "created_at": p.created_at,
                "updated_at": p.updated_at,
                "is_project": p.is_project,
                "datasets": datasets,
                "logo_url": project_logo_url,
                "thumbnailUrl": project_logo_url,
                "tags": p.tags
            })
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/projects/names-only")
def read_projects_names_only(db: Session = Depends(get_db)):
    """
    Ultra-lightweight endpoint for export dialog - returns ONLY IDs and names.
    Perfect for selection lists where you don't need any metadata.
    """
    try:
        from sqlalchemy.orm import selectinload, load_only
        
        # Only load ID and name fields - nothing else!
        # Need to load project_id for the relationship to work
        projects = db.query(models.Project).options(
            load_only(models.Project.id, models.Project.name),
            selectinload(models.Project.datasets).load_only(
                models.Dataset.id,
                models.Dataset.name,
                models.Dataset.project_id
            )
        ).all()
        
        result = []
        for p in projects:
            datasets = []
            if p.datasets:
                for d in p.datasets:
                    datasets.append({
                        "id": d.id,
                        "name": d.name
                    })
            
            result.append({
                "id": p.id,
                "name": p.name,
                "datasets": datasets
            })
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@router.get("/projects/{project_id}/datasets/list")
def list_project_datasets(
    project_id: int,
    include_thumbnails: bool = True,
    db: Session = Depends(get_db),
):
    """
    Lightweight datasets for grid/list views: metadata + counts + one preview image URL each.

    ``include_thumbnails``: when true, small ``data:image/...`` logos (under ~500k chars) are included;
    larger legacy base64 values are omitted in favor of the first-image preview with ``?thumb=300``.
    Relative ``/static/...`` paths always get a ``thumb`` query when missing so full originals are not loaded.
    Set include_thumbnails=false to omit all data URLs (smaller JSON; cards use file previews only).
    """
    from sqlalchemy import func
    from sqlalchemy.orm import load_only

    from ..dataset_list_helpers import first_preview_url_by_dataset, resolve_dataset_list_thumbnail

    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    datasets = (
        db.query(models.Dataset)
        .options(
            load_only(
                models.Dataset.id,
                models.Dataset.name,
                models.Dataset.description,
                models.Dataset._tags,
                models.Dataset.project_id,
                models.Dataset.image_count,
                models.Dataset.thumbnailUrl,
                models.Dataset.logo_url,
                models.Dataset.url,
                models.Dataset.created_at,
                models.Dataset.updated_at,
            )
        )
        .filter(models.Dataset.project_id == project_id)
        .all()
    )

    if not datasets:
        return {"success": True, "data": []}

    dataset_ids = [d.id for d in datasets]

    annotation_counts = dict(
        db.query(models.Annotation.dataset_id, func.count(models.Annotation.id))
        .filter(models.Annotation.dataset_id.in_(dataset_ids))
        .group_by(models.Annotation.dataset_id)
        .all()
    )

    annotation_file_counts = dict(
        db.query(models.AnnotationFile.dataset_id, func.count(models.AnnotationFile.id))
        .filter(models.AnnotationFile.dataset_id.in_(dataset_ids))
        .group_by(models.AnnotationFile.dataset_id)
        .all()
    )

    preview_by_ds = first_preview_url_by_dataset(db, dataset_ids)

    result = []
    for dataset in datasets:
        thumb = resolve_dataset_list_thumbnail(
            dataset.thumbnailUrl or dataset.logo_url,
            preview_by_ds.get(dataset.id),
            include_base64_thumbnails=include_thumbnails,
        )

        result.append(
            {
                "id": dataset.id,
                "name": dataset.name,
                "description": dataset.description,
                "project_id": dataset.project_id,
                "image_count": dataset.image_count,
                "annotation_count": annotation_counts.get(dataset.id, 0),
                "annotation_file_count": annotation_file_counts.get(dataset.id, 0),
                "tags": dataset.tags,
                "thumbnailUrl": thumb,
                "url": dataset.url,
                "created_at": dataset.created_at.isoformat() if dataset.created_at else None,
                "updated_at": dataset.updated_at.isoformat() if dataset.updated_at else None,
            }
        )

    return {"success": True, "data": result}


@router.get("/datasets/{dataset_id}/annotation-files/list")
def list_dataset_annotation_files(dataset_id: int, db: Session = Depends(get_db)):
    """
    Get a lightweight list of annotation files for a dataset.
    Only returns ID, name, and annotation count - no full annotation data.
    """
    # Verify dataset exists
    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    # Get annotation files with minimal data, ordered by date (newest first)
    annotation_files = db.query(models.AnnotationFile).filter(
        models.AnnotationFile.dataset_id == dataset_id
    ).order_by(models.AnnotationFile.created_at.desc()).all()

    # Some legacy/imported files have stale or zero `annotation_count` in
    # AnnotationFile even though rows exist in `annotations`. Compute live
    # counts once and use them as a fallback so UI selectors (e.g. augmentation
    # source picker) don't incorrectly show "0 annotations".
    from app.services.annotation_processing import (
        get_live_annotation_counts_by_file_id,
        resolve_annotation_count,
    )

    file_ids = [f.id for f in annotation_files if f.id]
    live_counts_by_file = get_live_annotation_counts_by_file_id(db, file_ids)

    result = []
    for ann_file in annotation_files:
        live_count = int(live_counts_by_file.get(ann_file.id, 0))
        effective_count = resolve_annotation_count(ann_file.annotation_count, live_count)
        result.append({
            "id": ann_file.id,
            "name": ann_file.name,
            "file_name": ann_file.name,
            "type": ann_file.type,
            "annotation_count": effective_count
        })

    # Fallback for legacy datasets where per-file counts were never persisted and
    # annotations are not linked row-wise to Annotation.annotation_file_id.
    # If there is a single annotation file and it still resolves to 0, use the
    # dataset-level annotation_count so UI selectors don't incorrectly show 0.
    if len(result) == 1 and int(result[0].get("annotation_count", 0) or 0) == 0:
        ds_total = int(dataset.annotation_count or 0)
        if ds_total > 0:
            result[0]["annotation_count"] = ds_total
    
    return {"success": True, "data": result}


@router.get("/projects/{project_id}/summary")
def get_project_summary(project_id: int, db: Session = Depends(get_db)):
    """Ultra-light: just name, description, tags, dates, dataset_count. No joins, no annotation queries."""
    from sqlalchemy.orm import load_only

    project = (
        db.query(models.Project)
        .options(
            load_only(
                models.Project.id,
                models.Project.name,
                models.Project.description,
                models.Project.is_project,
                models.Project._tags,
                models.Project.created_at,
                models.Project.updated_at,
            )
        )
        .filter(models.Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    dataset_count = (
        db.query(func.count(models.Dataset.id))
        .filter(models.Dataset.project_id == project_id)
        .scalar()
        or 0
    )

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "is_project": project.is_project,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "tags": project.tags,
        "logo_url": None,
        "thumbnailUrl": None,
        "datasets": [],
        "dataset_count": dataset_count,
    }


@router.get("/projects/{project_id}/sidebar-counts")
def get_project_sidebar_counts(project_id: int, db: Session = Depends(get_db)):
    """
    Single round-trip for project layout: models, evaluations (parent rows only), exports, pipelines.
    Uses COUNT queries only — no task metadata or pipeline bodies.
    """
    exists = db.query(models.Project.id).filter(models.Project.id == project_id).first()
    if not exists:
        raise HTTPException(status_code=404, detail="Project not found")

    models_count = (
        db.query(func.count(models.Task.id))
        .filter(
            models.Task.project_id == project_id,
            models.Task.task_type.in_(["yolo_training", "training"]),
        )
        .scalar()
        or 0
    )

    exports_count = (
        db.query(func.count(models.Task.id))
        .filter(
            models.Task.project_id == project_id,
            models.Task.task_type == "model_export",
        )
        .scalar()
        or 0
    )

    pipelines_count = (
        db.query(func.count(models.Pipeline.id))
        .filter(models.Pipeline.project_id == project_id)
        .scalar()
        or 0
    )

    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        evaluations_count = (
            db.execute(
                text(
                    """
                    SELECT COUNT(*) FROM tasks
                    WHERE project_id = :pid
                      AND task_type = 'model_evaluation'
                      AND (
                          task_metadata IS NULL
                          OR (task_metadata->>'parent_task_id') IS NULL
                          OR TRIM(COALESCE(task_metadata->>'parent_task_id', '')) = ''
                      )
                    """
                ),
                {"pid": project_id},
            ).scalar()
            or 0
        )
    elif dialect == "sqlite":
        evaluations_count = (
            db.execute(
                text(
                    """
                    SELECT COUNT(*) FROM tasks
                    WHERE project_id = :pid
                      AND task_type = 'model_evaluation'
                      AND (
                          task_metadata IS NULL
                          OR json_extract(task_metadata, '$.parent_task_id') IS NULL
                          OR TRIM(COALESCE(json_extract(task_metadata, '$.parent_task_id'), '')) = ''
                      )
                    """
                ),
                {"pid": project_id},
            ).scalar()
            or 0
        )
    else:
        evaluations_count = (
            db.query(func.count(models.Task.id))
            .filter(
                models.Task.project_id == project_id,
                models.Task.task_type == "model_evaluation",
            )
            .scalar()
            or 0
        )

    return {
        "success": True,
        "data": {
            "models": int(models_count),
            "evaluations": int(evaluations_count),
            "exports": int(exports_count),
            "pipelines": int(pipelines_count),
        },
    }


@router.get("/projects/{project_id}", response_model=schemas.Project)
def read_project(
    project_id: int,
    include_images: bool = True,
    include_dataset_annotation_files: bool = False,
    db: Session = Depends(get_db),
):
    """
    Get a single project by ID with all its datasets.

    Row logos and dataset thumbnails are optimized JPEG data URLs (~200×200); included by default.
    Set include_images=false to omit base64 and shrink the JSON.

    By default, per-dataset annotation_files lists are omitted (empty arrays). Loading every
    AnnotationFile row for large projects makes this endpoint very slow and huge; UIs that
    need file lists should use GET /datasets/{id}/annotation-files/list. Set
    include_dataset_annotation_files=true for the legacy embedded lists.
    """
    from sqlalchemy import func
    from sqlalchemy.orm import selectinload
    
    project = db.query(models.Project).options(
        selectinload(models.Project.datasets)
    ).filter(models.Project.id == project_id).first()
    
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Serialize datasets with efficient count queries
    datasets = []
    if project.datasets:
        # Get all dataset IDs for this project
        dataset_ids = [d.id for d in project.datasets]
        
        # Efficient count queries for annotations
        annotation_counts = dict(
            db.query(
                models.Annotation.dataset_id,
                func.count(models.Annotation.id)
            ).filter(
                models.Annotation.dataset_id.in_(dataset_ids)
            ).group_by(models.Annotation.dataset_id).all()
        )
        
        # Efficient count queries for annotation files
        annotation_file_counts = dict(
            db.query(
                models.AnnotationFile.dataset_id,
                func.count(models.AnnotationFile.id)
            ).filter(
                models.AnnotationFile.dataset_id.in_(dataset_ids)
            ).group_by(models.AnnotationFile.dataset_id).all()
        )
        
        annotation_files_by_dataset = {}
        if include_dataset_annotation_files:
            annotation_files = db.query(models.AnnotationFile).filter(
                models.AnnotationFile.dataset_id.in_(dataset_ids)
            ).all()

            for ann_file in annotation_files:
                if ann_file.dataset_id not in annotation_files_by_dataset:
                    annotation_files_by_dataset[ann_file.dataset_id] = []
                annotation_files_by_dataset[ann_file.dataset_id].append({
                    "id": ann_file.id,
                    "file_name": ann_file.name,
                    "name": ann_file.name,
                    "annotation_count": ann_file.annotation_count,
                    "created_at": ann_file.created_at,
                    "type": ann_file.type,
                })

        for dataset in project.datasets:
            datasets.append({
                "id": dataset.id,
                "name": dataset.name,
                "description": dataset.description,
                "tags": dataset.tags,
                "created_at": dataset.created_at,
                "updated_at": dataset.updated_at,
                "image_count": dataset.image_count,
                "annotation_count": annotation_counts.get(dataset.id, 0),
                "annotation_file_count": annotation_file_counts.get(dataset.id, 0),
                "annotation_files": annotation_files_by_dataset.get(dataset.id, []),
                "project_id": dataset.project_id,
                "thumbnailUrl": truncate_base64_url(dataset.thumbnailUrl, include_images),
                "logo_url": truncate_base64_url(dataset.logo_url, include_images),
                "url": dataset.url
            })
    
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "is_project": project.is_project,
        "datasets": datasets,
        "logo_url": truncate_base64_url(project.logo_url, include_images),
        "thumbnailUrl": truncate_base64_url(project.logo_url, include_images),
        "tags": project.tags
    }


@router.put("/projects/{project_id}")
async def update_project(
    project_id: int,
    name: str = Form(...),
    description: str = Form(""),
    tags: Optional[str] = Form(None),
    logo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db)
):
    try:
        project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        if tags:
            project.tags = json.loads(tags)
        project.name = name
        project.description = description
        if logo:
            logo_data = await logo.read()
            project.logo = logo_data
            mime_type = logo.content_type or "image/png"
            # Generate thumbnail for faster loading in list view
            thumbnail_url = create_thumbnail_base64(logo_data, mime_type)
            project.logo_url = thumbnail_url
        db.commit()
        db.refresh(project)
        # Return a lightweight response — omitting nested datasets avoids serialising
        # potentially large base64 thumbnails which caused "Failed to fetch" in the browser.
        # The caller (EditProjectDialog → ProjectCard) does navigate(0) on success anyway.
        return {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "tags": project.tags,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
            "is_project": project.is_project,
            "logo_url": project.logo_url,
            "thumbnailUrl": project.logo_url,
            "datasets": [],
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, db: Session = Depends(get_db)):
    """
    Delete a project and all its associated data.
    This removes both the database records and all physical files.
    """
    try:
        # Check if project exists
        project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        # Delete physical files before deleting database records
        try:
            # Delete from new projects structure: projects/{project_id}/
            project_dir = Path("projects") / str(project_id)
            if project_dir.exists():
                shutil.rmtree(project_dir)
                print(f"Deleted project directory: {project_dir}")
            else:
                print(f"Project directory not found: {project_dir}")
            
            # Also check and delete from old data structure for backward compatibility
            # Get all datasets for this project to clean up old structure
            datasets = db.query(models.Dataset).filter(models.Dataset.project_id == project_id).all()
            for dataset in datasets:
                old_images_dir = Path("data/images") / str(dataset.id)
                old_annotations_dir = Path("data/annotations") / str(dataset.id)
                
                if old_images_dir.exists():
                    shutil.rmtree(old_images_dir)
                    print(f"Deleted old images directory: {old_images_dir}")
                
                if old_annotations_dir.exists():
                    shutil.rmtree(old_annotations_dir)
                    print(f"Deleted old annotations directory: {old_annotations_dir}")
                
        except Exception as file_error:
            print(f"Warning: Could not delete some physical files: {file_error}")
            # Continue with database deletion even if file deletion fails

        # ORM delete per dataset (bulk DELETE skips cascades → FK violations).
        delete_project_record(db, project_id)
        db.commit()
        
        return {
            "success": True, 
            "message": "Project and all its datasets have been deleted"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/projects/{project_id}/duplicate")
async def duplicate_project(project_id: int, db: Session = Depends(get_db)):
    try:
        original_project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if original_project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        new_project = models.Project(
            name=f"{original_project.name} (Copy)",
            description=original_project.description,
            tags=original_project.tags,
            logo=original_project.logo,
            logo_url=original_project.logo_url
        )
        db.add(new_project)
        db.flush()
        for dataset in original_project.datasets:
            new_dataset = models.Dataset(
                name=dataset.name,
                description=dataset.description,
                tags=dataset.tags,
                project_id=new_project.id,
                image_count=dataset.image_count,
                # annotation counts are computed on demand
            )
            db.add(new_dataset)
        db.commit()
        db.refresh(new_project)
        return {
            "success": True,
            "data": {
                "id": new_project.id,
                "name": new_project.name,
                "description": new_project.description,
                "tags": new_project.tags,
                "created_at": new_project.created_at.isoformat(),
                "updated_at": new_project.updated_at.isoformat(),
                "datasets": new_project.datasets,
                "logo_url": new_project.logo_url
            }
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/test-project-tags")
async def test_project_tags(db: Session = Depends(get_db)):
    project = models.Project(
        name="Test Project with Tags",
        description="Testing tags functionality",
        tags=["test", "tags", "feature"]
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {
        "success": True,
        "data": {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "tags": project.tags
        }
    }


def sanitize_filename(name: str) -> str:
    """Sanitize a string to be used as part of a filename"""
    # Replace spaces and special characters with underscores
    sanitized = re.sub(r'[^\w\-.]', '_', name)
    # Remove consecutive underscores
    sanitized = re.sub(r'_+', '_', sanitized)
    # Remove leading/trailing underscores
    sanitized = sanitized.strip('_')
    return sanitized


@router.post("/projects/{project_id}/datasets/merge")
async def merge_datasets(
    project_id: int,
    request: MergeDatasetsRequest,
    db: Session = Depends(get_db)
):
    """
    Merge multiple datasets into a new dataset.
    Images and annotations are copied with renamed filenames using the source dataset name as prefix.
    """
    try:
        # Validate project exists
        project = db.query(models.Project).filter(models.Project.id == project_id).first()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        
        # Validate at least 2 datasets to merge
        if len(request.dataset_ids) < 2:
            raise HTTPException(status_code=400, detail="At least 2 datasets are required for merge")
        
        # Get all source datasets
        source_datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(request.dataset_ids),
            models.Dataset.project_id == project_id
        ).all()
        
        if len(source_datasets) != len(request.dataset_ids):
            raise HTTPException(status_code=404, detail="One or more datasets not found in this project")
        
        # Create the new merged dataset
        new_dataset = models.Dataset(
            name=request.name,
            description=f"Merged from: {', '.join([d.name for d in source_datasets])}",
            project_id=project_id,
            image_count=0
        )
        db.add(new_dataset)
        db.flush()  # Get the new dataset ID
        
        # Create directories for new dataset
        new_dataset_dir = Path("projects") / str(project_id) / str(new_dataset.id)
        new_images_dir = new_dataset_dir / "images"
        new_images_dir.mkdir(parents=True, exist_ok=True)
        new_thumbnails_dir = new_images_dir / "thumbnails"
        new_thumbnails_dir.mkdir(parents=True, exist_ok=True)

        # Tabbed dataset UI loads images via collections — create a default layer.
        from app.services.dataset_collections_service import ensure_default_image_collection

        default_collection = ensure_default_image_collection(
            db,
            new_dataset.id,
            description="Merged images from source datasets",
        )
        if default_collection is None:
            default_collection = (
                db.query(models.ImageCollection)
                .filter(
                    models.ImageCollection.dataset_id == new_dataset.id,
                    models.ImageCollection.is_default == True,
                )
                .first()
            )
        db.flush()
        
        total_images = 0
        total_annotations = 0
        skipped_images = 0
        image_id_mapping = {}  # Maps old image_id to new image_id for annotation updates
        
        # Process each source dataset
        for source_dataset in source_datasets:
            dataset_prefix = sanitize_filename(source_dataset.name)
            
            # Get all images from source dataset
            source_images = db.query(models.Image).filter(
                models.Image.dataset_id == source_dataset.id
            ).all()
            
            for source_image in source_images:
                # Generate new filename with dataset prefix
                new_filename = f"{dataset_prefix}_{source_image.file_name}"
                
                source_image_path = resolve_dataset_image_path_from_models(
                    source_image,
                    dataset_id=source_dataset.id,
                    project_id=project_id,
                )
                
                # Create new image record regardless of whether file exists
                # This ensures annotations can be properly mapped
                new_image = models.Image(
                    dataset_id=new_dataset.id,
                    collection_id=default_collection.id,
                    file_name=new_filename,
                    file_size=source_image.file_size,
                    width=source_image.width,
                    height=source_image.height,
                    url=f"/static/projects/{project_id}/{new_dataset.id}/images/{new_filename}",
                    thumbnail_url=(
                        source_image.thumbnail_url.replace(
                            f"/{source_dataset.id}/",
                            f"/{new_dataset.id}/",
                        )
                        if source_image.thumbnail_url
                        else f"/static/projects/{project_id}/{new_dataset.id}/images/{new_filename}"
                    ),
                    group_id=source_image.group_id,
                    annotations_count=source_image.annotations_count or 0,
                )
                db.add(new_image)
                db.flush()  # Get the new image ID
                
                image_id_mapping[source_image.id] = new_image.id
                
                # Copy the physical file if it exists
                if source_image_path and source_image_path.exists():
                    new_image_path = new_images_dir / new_filename
                    shutil.copy2(source_image_path, new_image_path)
                    new_image.file_size = new_image_path.stat().st_size

                    # Copy thumbnail when present (thumbnails/ sibling or .thumbs cache)
                    thumb_copied = False
                    for thumb_candidate in (
                        source_image_path.parent / "thumbnails" / source_image_path.name,
                        source_image_path.parent / "thumbnails" / source_image.file_name,
                    ):
                        if thumb_candidate.is_file():
                            thumb_dest = new_thumbnails_dir / new_filename
                            shutil.copy2(thumb_candidate, thumb_dest)
                            new_image.thumbnail_url = (
                                f"/static/projects/{project_id}/{new_dataset.id}"
                                f"/images/thumbnails/{new_filename}"
                            )
                            thumb_copied = True
                            break
                    if not thumb_copied:
                        new_image.thumbnail_url = new_image.url

                    total_images += 1
                else:
                    skipped_images += 1
                    print(
                        f"Warning: Image file not found, creating DB record only: "
                        f"{source_image.file_name} (dataset {source_dataset.id})"
                    )
            
            # Copy annotation files and annotations
            source_annotation_files = db.query(models.AnnotationFile).filter(
                models.AnnotationFile.dataset_id == source_dataset.id
            ).all()
            
            for source_ann_file in source_annotation_files:
                # Create new annotation file with dataset prefix
                new_ann_file_name = f"{dataset_prefix}_{source_ann_file.name}"
                new_ann_file_id = f"{dataset_prefix}_{source_ann_file.id}"
                
                new_ann_file = models.AnnotationFile(
                    id=new_ann_file_id,
                    dataset_id=new_dataset.id,
                    name=new_ann_file_name,
                    format=source_ann_file.format,
                    type=source_ann_file.type,
                    annotation_count=source_ann_file.annotation_count,
                    image_count=source_ann_file.image_count,
                    category_count=source_ann_file.category_count,
                    statistics=source_ann_file.statistics,
                    is_processed=source_ann_file.is_processed,
                    processing_status=source_ann_file.processing_status
                )
                db.add(new_ann_file)
                db.flush()
                
                # Copy annotation classes (categories)
                source_ann_classes = db.query(models.AnnotationClass).filter(
                    models.AnnotationClass.annotation_file_id == source_ann_file.id
                ).all()
                
                for source_class in source_ann_classes:
                    new_class = models.AnnotationClass(
                        annotation_file_id=new_ann_file_id,
                        class_name=source_class.class_name,
                        category_id=source_class.category_id,
                        count=source_class.count,
                        color=source_class.color,
                        opacity=source_class.opacity
                    )
                    db.add(new_class)
                
                # Copy annotation file images mapping
                source_ann_images = db.query(models.AnnotationFileImage).filter(
                    models.AnnotationFileImage.annotation_file_id == source_ann_file.id
                ).all()
                
                for source_ann_img in source_ann_images:
                    # Map to the new image ID if available
                    new_dataset_image_id = image_id_mapping.get(source_ann_img.dataset_image_id) if source_ann_img.dataset_image_id else None
                    # Generate new filename with prefix
                    new_file_name = f"{dataset_prefix}_{source_ann_img.file_name}" if source_ann_img.file_name else None
                    
                    new_ann_img = models.AnnotationFileImage(
                        annotation_file_id=new_ann_file_id,
                        coco_image_id=source_ann_img.coco_image_id,
                        file_name=new_file_name,
                        dataset_image_id=new_dataset_image_id,
                        width=source_ann_img.width,
                        height=source_ann_img.height
                    )
                    db.add(new_ann_img)
                
                # Copy all annotations for this annotation file
                source_annotations = db.query(models.Annotation).filter(
                    models.Annotation.annotation_file_id == source_ann_file.id
                ).all()
                
                for source_ann in source_annotations:
                    # Map the old image_id to the new image_id
                    new_image_id = image_id_mapping.get(source_ann.image_id)
                    
                    if new_image_id:
                        new_annotation = models.Annotation(
                            annotation_file_id=new_ann_file_id,
                            image_id=new_image_id,
                            dataset_id=new_dataset.id,
                            coco_image_id=source_ann.coco_image_id,
                            coco_annotation_id=source_ann.coco_annotation_id,
                            category_id=source_ann.category_id,
                            category=source_ann.category,
                            bbox_x=source_ann.bbox_x,
                            bbox_y=source_ann.bbox_y,
                            bbox_width=source_ann.bbox_width,
                            bbox_height=source_ann.bbox_height,
                            bbox=source_ann.bbox,
                            segmentation=source_ann.segmentation,
                            area=source_ann.area,
                            confidence=source_ann.confidence
                        )
                        db.add(new_annotation)
                        total_annotations += 1
        
        # Update image count on new dataset (count all images with DB records)
        new_dataset.image_count = len(image_id_mapping)
        
        db.commit()
        db.refresh(new_dataset)
        
        print(f"Dataset merge completed: {len(image_id_mapping)} images ({total_images} with files, {skipped_images} DB only), {total_annotations} annotations")
        
        return {
            "success": True,
            "data": {
                "id": new_dataset.id,
                "name": new_dataset.name,
                "description": new_dataset.description,
                "total_images": len(image_id_mapping),
                "total_images_with_files": total_images,
                "skipped_images": skipped_images,
                "total_annotations": total_annotations,
                "source_datasets": [d.name for d in source_datasets]
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        # Clean up any created files on error
        if 'new_dataset' in locals() and new_dataset.id:
            cleanup_dir = Path("projects") / str(project_id) / str(new_dataset.id)
            if cleanup_dir.exists():
                shutil.rmtree(cleanup_dir)
        raise HTTPException(status_code=500, detail=str(e))
