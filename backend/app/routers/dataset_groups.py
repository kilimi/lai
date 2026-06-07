from fastapi import APIRouter, Depends, HTTPException, Form
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from pathlib import Path
from typing import List, Optional, Dict
import json
import logging
import shutil

from .. import models, schemas
from ..database import get_db
from ..dataset_list_helpers import first_preview_url_by_dataset, resolve_dataset_list_thumbnail
from ..dataset_media_paths import iter_projects_roots

logger = logging.getLogger(__name__)

router = APIRouter()


def _remove_dataset_group_filesystem_tree(project_id: Optional[int], group_id: int) -> None:
    """
    Remove optional on-disk artifacts for this group under
    ``<projects_root>/<project_id>/dataset_groups/<group_id>/``.
    Dataset groups are primarily a DB row; this clears any exported or future cache paths.
    """
    if project_id is None:
        return
    for root in iter_projects_roots():
        rel = Path(str(project_id)) / "dataset_groups" / str(group_id)
        path = root / rel
        try:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=False)
                logger.info("Removed dataset group directory %s", path)
        except OSError as e:
            logger.warning("Could not remove dataset group dir %s: %s", path, e)


def get_dataset_annotation_counts(db: Session, dataset_ids: List[int]) -> Dict[int, int]:
    """Get annotation counts for multiple datasets efficiently"""
    if not dataset_ids:
        return {}
    return dict(
        db.query(
            models.Annotation.dataset_id,
            func.count(models.Annotation.id)
        ).filter(
            models.Annotation.dataset_id.in_(dataset_ids)
        ).group_by(models.Annotation.dataset_id).all()
    )


def get_dataset_annotation_file_counts(db: Session, dataset_ids: List[int]) -> Dict[int, int]:
    """Get annotation file counts for multiple datasets efficiently"""
    if not dataset_ids:
        return {}
    return dict(
        db.query(
            models.AnnotationFile.dataset_id,
            func.count(models.AnnotationFile.id)
        ).filter(
            models.AnnotationFile.dataset_id.in_(dataset_ids)
        ).group_by(models.AnnotationFile.dataset_id).all()
    )


@router.post("/projects/{project_id}/dataset-groups/")
async def create_dataset_group(
    project_id: int,
    name: str = Form(...),
    description: str = Form(""),
    dataset_ids: str = Form(...),  # Receive as comma-separated string
    url: str = Form(""),
    db: Session = Depends(get_db)
):
    """Create a new dataset group within a project"""
    
    # Verify project exists
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Parse dataset IDs from comma-separated string
    try:
        if dataset_ids.strip():
            dataset_id_list = [int(id.strip()) for id in dataset_ids.split(',') if id.strip()]
        else:
            dataset_id_list = []
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid dataset ID format")
    
    if not dataset_id_list:
        raise HTTPException(status_code=400, detail="At least one dataset must be selected")
    
    # Verify all datasets exist and belong to the project
    datasets = db.query(models.Dataset).filter(
        models.Dataset.id.in_(dataset_id_list),
        models.Dataset.project_id == project_id
    ).all()
    
    if len(datasets) != len(dataset_id_list):
        raise HTTPException(status_code=400, detail="Some datasets not found or don't belong to this project")
    
    # Create the group
    group = models.DatasetGroup(
        name=name,
        description=description,
        project_id=project_id,
        dataset_ids=dataset_id_list,
        url=url
    )
    
    db.add(group)
    db.commit()
    db.refresh(group)
    
    # Get annotation counts efficiently
    dataset_ids = [d.id for d in datasets]
    annotation_counts = get_dataset_annotation_counts(db, dataset_ids)
    
    # Return the group with dataset details
    group_data = {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "project_id": group.project_id,
        "dataset_ids": group.datasets_list,
        "dataset_count": group.dataset_count,
        "url": group.url,
        "datasets": [
                {
                "id": d.id,
                "name": d.name,
                "thumbnailUrl": d.thumbnailUrl,
                "image_count": d.image_count,
                "annotation_count": annotation_counts.get(d.id, 0),
                "url": d.url
            }
            for d in datasets
        ],
        "created_at": group.created_at.isoformat(),
        "updated_at": group.updated_at.isoformat()
    }
    
    return {"success": True, "data": group_data}


@router.get("/projects/{project_id}/dataset-groups/")
async def get_dataset_groups(
    project_id: int,
    include_annotation_files: bool = False,
    db: Session = Depends(get_db)
):
    """Get all dataset groups for a project. List view omits per-file annotation lists unless include_annotation_files=true."""
    
    # Verify project exists
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    groups = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.project_id == project_id
    ).all()
    
    # Collect all dataset IDs across all groups for batch queries
    all_dataset_ids = []
    for group in groups:
        if group.datasets_list:
            all_dataset_ids.extend(group.datasets_list)
    all_dataset_ids = list(set(all_dataset_ids))
    
    # Get all datasets at once
    # Use load_only to avoid loading large binary logo field (can be MBs)
    from sqlalchemy.orm import load_only
    all_datasets = {}
    if all_dataset_ids:
        datasets_list = db.query(models.Dataset).options(
            load_only(
                models.Dataset.id,
                models.Dataset.name,
                models.Dataset.description,
                models.Dataset._tags,
                models.Dataset.project_id,
                models.Dataset.image_count,
                models.Dataset.thumbnailUrl,
                models.Dataset.url,
                models.Dataset.created_at,
                models.Dataset.updated_at
            )
        ).filter(
            models.Dataset.id.in_(all_dataset_ids)
        ).all()
        all_datasets = {d.id: d for d in datasets_list}
    
    # Get annotation counts efficiently
    annotation_counts = get_dataset_annotation_counts(db, all_dataset_ids)
    annotation_file_counts = get_dataset_annotation_file_counts(db, all_dataset_ids)

    preview_by_ds = first_preview_url_by_dataset(db, all_dataset_ids)
    
    # Optional: full annotation file rows (heavy) — only for editors that need them
    annotation_files_by_dataset = {}
    if include_annotation_files and all_dataset_ids:
        annotation_files_query = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.dataset_id.in_(all_dataset_ids)
        ).all()
        
        ann_file_ids = [af.id for af in annotation_files_query]
        
        ann_file_counts = {}
        if ann_file_ids:
            ann_file_counts = dict(
                db.query(
                    models.Annotation.annotation_file_id,
                    func.count(models.Annotation.id)
                ).filter(
                    models.Annotation.annotation_file_id.in_(ann_file_ids)
                ).group_by(models.Annotation.annotation_file_id).all()
            )
        
        for ann_file in annotation_files_query:
            if ann_file.dataset_id not in annotation_files_by_dataset:
                annotation_files_by_dataset[ann_file.dataset_id] = []
            
            annotation_files_by_dataset[ann_file.dataset_id].append({
                "id": ann_file.id,
                "file_name": ann_file.name,
                "name": ann_file.name,
                "annotation_count": ann_file_counts.get(ann_file.id, 0)
            })
    
    result = []
    for group in groups:
        # Get datasets for this group
        datasets = []
        if group.datasets_list:
            datasets = [all_datasets[did] for did in group.datasets_list if did in all_datasets]
            
            # Clean up deleted datasets from the group
            existing_dataset_ids = [d.id for d in datasets]
            if set(existing_dataset_ids) != set(group.datasets_list):
                # Some datasets were deleted, update the group
                group.dataset_ids = existing_dataset_ids
                db.commit()
        
        group_data = {
            "id": group.id,
            "name": group.name,
            "description": group.description,
            "project_id": group.project_id,
            "dataset_ids": group.datasets_list,
            "dataset_count": group.dataset_count,
            "url": group.url,
            "datasets": [
                {
                    "id": d.id,
                    "name": d.name,
                    "thumbnailUrl": resolve_dataset_list_thumbnail(
                        d.thumbnailUrl,
                        preview_by_ds.get(d.id),
                        include_base64_thumbnails=True,
                    ),
                    "image_count": d.image_count,
                    "annotation_count": annotation_counts.get(d.id, 0),
                    "annotation_file_count": annotation_file_counts.get(d.id, 0),
                    "annotation_files": annotation_files_by_dataset.get(d.id, []) if include_annotation_files else [],
                    "tags": d.tags,
                    "url": d.url
                }
                for d in datasets
            ],
            "created_at": group.created_at.isoformat(),
            "updated_at": group.updated_at.isoformat()
        }
        result.append(group_data)
    
    return {"success": True, "data": result}


@router.get("/dataset-groups/{group_id}")
async def get_dataset_group(
    group_id: int,
    db: Session = Depends(get_db)
):
    """Get a specific dataset group"""
    
    group = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.id == group_id
    ).first()
    
    if not group:
        raise HTTPException(status_code=404, detail="Dataset group not found")
    
    # Get datasets for this group
    datasets = []
    dataset_ids = []
    if group.datasets_list:
        datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(group.datasets_list)
        ).all()
        dataset_ids = [d.id for d in datasets]
        
        # Clean up deleted datasets from the group
        if set(dataset_ids) != set(group.datasets_list):
            # Some datasets were deleted, update the group
            group.dataset_ids = dataset_ids
            db.commit()
            db.refresh(group)
    
    # Get annotation counts efficiently
    annotation_counts = get_dataset_annotation_counts(db, dataset_ids)
    
    group_data = {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "project_id": group.project_id,
        "dataset_ids": group.datasets_list,
        "dataset_count": group.dataset_count,
        "url": group.url,
        "datasets": [
            {
                "id": d.id,
                "name": d.name,
                "description": d.description,
                "thumbnailUrl": d.thumbnailUrl,
                "image_count": d.image_count,
                "annotation_count": annotation_counts.get(d.id, 0),
                "tags": d.tags,
                "url": d.url,
                "created_at": d.created_at.isoformat()
            }
            for d in datasets
        ],
        "created_at": group.created_at.isoformat(),
        "updated_at": group.updated_at.isoformat()
    }
    
    return {"success": True, "data": group_data}


@router.put("/dataset-groups/{group_id}")
async def update_dataset_group(
    group_id: int,
    name: str = Form(None),
    description: str = Form(None),
    dataset_ids: str = Form(None),  # Receive as comma-separated string
    url: str = Form(None),
    db: Session = Depends(get_db)
):
    """Update a dataset group"""
    
    group = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.id == group_id
    ).first()
    
    if not group:
        raise HTTPException(status_code=404, detail="Dataset group not found")
    
    # Update fields if provided
    if name is not None:
        group.name = name
    if description is not None:
        group.description = description
    if url is not None:
        group.url = url
    if dataset_ids is not None:
        # Parse dataset IDs from comma-separated string
        try:
            if dataset_ids.strip():
                dataset_id_list = [int(id.strip()) for id in dataset_ids.split(',') if id.strip()]
            else:
                dataset_id_list = []
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid dataset ID format")
        
        if not dataset_id_list:
            raise HTTPException(status_code=400, detail="At least one dataset must be selected")
        
        # Verify all datasets exist and belong to the same project
        datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(dataset_id_list),
            models.Dataset.project_id == group.project_id
        ).all()
        
        # Filter to only existing datasets (ignore deleted ones)
        existing_dataset_ids = [d.id for d in datasets]
        if not existing_dataset_ids:
            raise HTTPException(status_code=400, detail="At least one valid dataset must be selected")
        
        # Use only the existing dataset IDs
        group.datasets_list = existing_dataset_ids
    
    db.commit()
    db.refresh(group)
    
    # Return updated group
    datasets = []
    dataset_ids_list = []
    if group.datasets_list:
        datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(group.datasets_list)
        ).all()
        dataset_ids_list = [d.id for d in datasets]
    
    # Get annotation counts efficiently
    annotation_counts = get_dataset_annotation_counts(db, dataset_ids_list)
    
    group_data = {
        "id": group.id,
        "name": group.name,
        "description": group.description,
        "project_id": group.project_id,
        "dataset_ids": group.datasets_list,
        "dataset_count": group.dataset_count,
        "url": group.url,
        "datasets": [
                {
                "id": d.id,
                "name": d.name,
                "thumbnailUrl": d.thumbnailUrl,
                "image_count": d.image_count,
                "annotation_count": annotation_counts.get(d.id, 0),
                "url": d.url
            }
            for d in datasets
        ],
        "created_at": group.created_at.isoformat(),
        "updated_at": group.updated_at.isoformat()
    }
    
    return {"success": True, "data": group_data}


@router.delete("/dataset-groups/{group_id}")
async def delete_dataset_group(
    group_id: int,
    db: Session = Depends(get_db)
):
    """Delete a dataset group row and any optional on-disk ``dataset_groups/<id>/`` tree."""
    
    group = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.id == group_id
    ).first()
    
    if not group:
        raise HTTPException(status_code=404, detail="Dataset group not found")

    pid = group.project_id
    db.delete(group)
    db.commit()

    _remove_dataset_group_filesystem_tree(pid, group_id)

    return {"success": True, "message": "Dataset group deleted successfully"}


@router.delete("/projects/{project_id}/dataset-groups/{group_id}")
async def delete_dataset_group_under_project(
    project_id: int,
    group_id: int,
    db: Session = Depends(get_db),
):
    """Same as ``DELETE /dataset-groups/{group_id}``; verifies the group belongs to ``project_id``."""
    group = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.id == group_id
    ).first()
    if not group:
        raise HTTPException(status_code=404, detail="Dataset group not found")
    if int(group.project_id) != int(project_id):
        raise HTTPException(
            status_code=400,
            detail="Dataset group does not belong to this project",
        )
    return await delete_dataset_group(group_id, db)


@router.get("/projects/{project_id}/search")
async def search_datasets_and_groups(
    project_id: int,
    q: str = "",
    tag: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Search datasets and groups within a project"""
    
    # Verify project exists
    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    results = {
        "datasets": [],
        "groups": [],
        "expanded_groups": []  # Groups that contain matching datasets
    }
    
    # Search datasets
    dataset_query = db.query(models.Dataset).filter(
        models.Dataset.project_id == project_id
    )
    
    if q:
        dataset_query = dataset_query.filter(
            models.Dataset.name.ilike(f"%{q}%") |
            models.Dataset.description.ilike(f"%{q}%")
        )
    
    datasets = dataset_query.all()
    
    # Filter by tag if specified
    if tag:
        datasets = [d for d in datasets if tag in (d.tags or [])]
    
    # Also filter by search query in tags
    if q:
        tag_filtered = [d for d in datasets if any(q.lower() in (tag_item or "").lower() for tag_item in (d.tags or []))]
        # Combine name/description matches with tag matches
        all_dataset_ids = set([d.id for d in datasets] + [d.id for d in tag_filtered])
        datasets = db.query(models.Dataset).filter(
            models.Dataset.id.in_(all_dataset_ids)
        ).all()
    
    # Get all dataset IDs for efficient annotation count query
    all_dataset_ids_for_counts = [d.id for d in datasets]
    
    # Also collect dataset IDs from groups
    groups = db.query(models.DatasetGroup).filter(
        models.DatasetGroup.project_id == project_id
    ).all()
    
    for group in groups:
        if group.datasets_list:
            all_dataset_ids_for_counts.extend(group.datasets_list)
    
    all_dataset_ids_for_counts = list(set(all_dataset_ids_for_counts))
    
    # Get annotation counts efficiently for all datasets
    annotation_counts = get_dataset_annotation_counts(db, all_dataset_ids_for_counts)
    
    results["datasets"] = [
        {
            "id": d.id,
            "name": d.name,
            "description": d.description,
            "thumbnailUrl": d.thumbnailUrl,
            "image_count": d.image_count,
            "annotation_count": annotation_counts.get(d.id, 0),
            "tags": d.tags,
            "url": d.url,
            "created_at": d.created_at.isoformat()
        }
        for d in datasets
    ]
    
    # Search groups
    for group in groups:
        group_matches = False
        expanded = False
        
        # Check if group name or description matches
        if q:
            if (q.lower() in group.name.lower() or 
                (group.description and q.lower() in group.description.lower())):
                group_matches = True
        else:
            group_matches = True  # Include all groups if no search query
        
        # Check if any datasets in the group match
        group_datasets = []
        if group.datasets_list:
            group_datasets = db.query(models.Dataset).filter(
                models.Dataset.id.in_(group.datasets_list)
            ).all()
            
            # Check if any dataset in group matches search criteria
            for dataset in group_datasets:
                dataset_matches = False
                
                if q:
                    if (q.lower() in dataset.name.lower() or
                        (dataset.description and q.lower() in dataset.description.lower()) or
                        any(q.lower() in (tag_item or "").lower() for tag_item in (dataset.tags or []))):
                        dataset_matches = True
                
                if tag and tag in (dataset.tags or []):
                    dataset_matches = True
                
                if dataset_matches:
                    expanded = True
                    break
        
        if group_matches or expanded:
            group_data = {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "project_id": group.project_id,
                "dataset_ids": group.datasets_list,
                "dataset_count": group.dataset_count,
                "url": group.url,
                "datasets": [
                    {
                        "id": d.id,
                        "name": d.name,
                        "thumbnailUrl": d.thumbnailUrl,
                        "image_count": d.image_count,
                        "annotation_count": annotation_counts.get(d.id, 0),
                        "tags": d.tags,
                        "url": d.url
                    }
                    for d in group_datasets
                ],
                "created_at": group.created_at.isoformat(),
                "updated_at": group.updated_at.isoformat()
            }
            
            results["groups"].append(group_data)
            
            if expanded:
                results["expanded_groups"].append(group.id)
    
    return {"success": True, "data": results}
