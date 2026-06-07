"""
API endpoints for auto-annotation with AI models
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime
import logging
import os

from ..auto_annotate_collection import resolve_auto_annotate_source_collection_id
from ..database import get_db
from ..models import Task, Dataset, AnnotationFile, ImageCollection
from ..foundation_models import pretrained_yolo_catalog

router = APIRouter()
logger = logging.getLogger(__name__)

# Pre-trained YOLO models (same matrix as Auto-Annotate / Docker pre-download)
PRETRAINED_MODELS = pretrained_yolo_catalog()

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
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
]


class AutoAnnotationRequest(BaseModel):
    """Request model for auto-annotation"""
    dataset_id: int
    model_path: str  # Path to YOLO model (.pt file)
    annotation_name: str  # Name for the new annotation file
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    use_segmentation: bool = True  # Use segmentation if model supports it
    task_name: Optional[str] = None  # Custom task name


class PretrainedAutoAnnotationRequest(BaseModel):
    """Request model for auto-annotation with pre-trained models"""
    dataset_id: int
    model_name: str  # e.g., "yolo11n-seg.pt"
    annotation_name: str
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    task_name: Optional[str] = None
    # Omit to use the dataset default (or first) collection when the dataset uses collections
    collection_id: Optional[int] = None


@router.get("/auto-annotate/pretrained-models")
async def list_pretrained_models():
    """
    List available pre-trained YOLO models
    """
    models = []
    for model_file, info in PRETRAINED_MODELS.items():
        models.append({
            "model_file": model_file,
            "name": info["name"],
            "type": info["type"],
            "num_classes": info["classes"],
            "class_names": COCO_CLASSES
        })
    
    return {
        "success": True,
        "models": models,
        "count": len(models)
    }


@router.post("/auto-annotate/pretrained")
async def start_auto_annotation_pretrained(
    request: PretrainedAutoAnnotationRequest,
    db: Session = Depends(get_db)
):
    """
    Start auto-annotation using a pre-trained YOLO model
    """
    try:
        # Validate model name
        if request.model_name not in PRETRAINED_MODELS:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid model name. Available models: {', '.join(PRETRAINED_MODELS.keys())}"
            )
        
        model_info = PRETRAINED_MODELS[request.model_name]
        
        # Validate dataset exists
        dataset = db.query(Dataset).filter(Dataset.id == request.dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        cid_req = request.collection_id
        if cid_req is not None:
            coll = db.query(ImageCollection).filter(
                ImageCollection.id == cid_req,
                ImageCollection.dataset_id == request.dataset_id,
            ).first()
            if not coll:
                raise HTTPException(
                    status_code=400,
                    detail="collection_id must belong to the selected dataset",
                )
        effective_collection_id = resolve_auto_annotate_source_collection_id(
            db, request.dataset_id, cid_req
        )
        
        # Generate task name
        task_name = request.task_name or f"Auto-Annotate {dataset.name} with {model_info['name']}"
        
        # Check if annotation name already exists
        existing_annotation = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == request.dataset_id,
            AnnotationFile.name == request.annotation_name if request.annotation_name.endswith('.json') else f"{request.annotation_name}.json"
        ).first()
        
        if existing_annotation:
            raise HTTPException(
                status_code=400, 
                detail=f"Annotation file '{request.annotation_name}' already exists for this dataset"
            )
        
        # Determine if segmentation should be used
        use_segmentation = model_info["type"] == "segmentation"
        
        # Create task in database
        task = Task(
            name=task_name,
            task_type="auto_annotation",
            status="pending",
            project_id=dataset.project_id,
            progress=0,
            task_metadata={
                "dataset_id": request.dataset_id,
                "dataset_name": dataset.name,
                "model_name": request.model_name,
                "model_type": model_info["type"],
                "annotation_name": request.annotation_name,
                "conf_threshold": request.conf_threshold,
                "iou_threshold": request.iou_threshold,
                "use_segmentation": use_segmentation,
                "class_names": COCO_CLASSES,
                "num_classes": len(COCO_CLASSES),
                "is_pretrained": True,
                **(
                    {"collection_id": effective_collection_id}
                    if effective_collection_id is not None
                    else {}
                ),
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Start Celery task with model name (Ultralytics will download if needed)
        from app.tasks.auto_annotation_tasks import auto_annotate_yolo
        
        celery_task = auto_annotate_yolo.delay(
            task.id,
            request.model_name,  # Pass model name, not path
            request.dataset_id,
            COCO_CLASSES,
            request.annotation_name,
            request.conf_threshold,
            request.iou_threshold,
            use_segmentation
        )
        
        # Update task with Celery ID
        task.task_metadata = {
            **task.task_metadata,
            'celery_task_id': celery_task.id
        }
        db.commit()
        
        logger.info(f"Started pretrained auto-annotation task {task.id} with Celery task {celery_task.id}")
        
        return {
            "success": True,
            "message": "Auto-annotation started",
            "task_id": task.id,
            "task_name": task.name,
            "model_name": request.model_name,
            "model_type": model_info["type"],
            "num_classes": len(COCO_CLASSES),
            "class_names": COCO_CLASSES
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting auto-annotation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start auto-annotation: {str(e)}")


@router.post("/auto-annotate/yolo/from-training")
async def start_auto_annotation_from_training(
    training_task_id: int,
    dataset_id: int,
    annotation_name: str,
    conf_threshold: float = 0.25,
    iou_threshold: float = 0.45,
    use_segmentation: bool = True,
    checkpoint: str = "best",
    task_name: Optional[str] = None,
    collection_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """
    Start auto-annotation using a model from a training task
    
    Args:
        training_task_id: ID of the training task
        dataset_id: Dataset to annotate
        annotation_name: Name for the annotation file
        conf_threshold: Confidence threshold
        iou_threshold: IoU threshold
        use_segmentation: Use segmentation if available
        checkpoint: "best" or "last"
        task_name: Custom task name
    """
    try:
        # Validate training task
        training_task = db.query(Task).filter(Task.id == training_task_id).first()
        if not training_task or training_task.status != 'completed':
            raise HTTPException(status_code=404, detail="Training task not found or not completed")
        
        # Validate dataset exists
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")

        cid_req = collection_id
        if cid_req is not None:
            coll = db.query(ImageCollection).filter(
                ImageCollection.id == cid_req,
                ImageCollection.dataset_id == dataset_id,
            ).first()
            if not coll:
                raise HTTPException(
                    status_code=400,
                    detail="collection_id must belong to the selected dataset",
                )
        effective_collection_id = resolve_auto_annotate_source_collection_id(
            db, dataset_id, cid_req
        )
        
        # Get model path from training task
        task_metadata = training_task.task_metadata or {}
        project_id = training_task.project_id
        
        # Find best or last model
        training_dir = Path("projects") / str(project_id) / "training" / f"task_{training_task_id}"
        weights_dir = training_dir / "weights"
        
        if not weights_dir.exists():
            raise HTTPException(status_code=404, detail="Training weights directory not found")
        
        model_file = weights_dir / f"{checkpoint}.pt"
        if not model_file.exists():
            raise HTTPException(status_code=404, detail=f"Model checkpoint '{checkpoint}.pt' not found")
        
        # Get class names from training task
        class_names = task_metadata.get('class_names', [])
        if not class_names:
            # Try to load from model
            try:
                from app.tasks.training_common import get_ultralytics_yolo
                YOLO = get_ultralytics_yolo()
                temp_model = YOLO(str(model_file))
                class_names = list(temp_model.names.values())
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Could not extract class names: {str(e)}")
        
        # Generate task name
        task_name = task_name or f"Auto-Annotate {dataset.name} with {training_task.name}"
        
        # Check if annotation name already exists
        existing_annotation = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id,
            AnnotationFile.name == annotation_name if annotation_name.endswith('.json') else f"{annotation_name}.json"
        ).first()
        
        if existing_annotation:
            raise HTTPException(
                status_code=400, 
                detail=f"Annotation file '{annotation_name}' already exists for this dataset"
            )
        
        # Create task in database
        task = Task(
            name=task_name,
            task_type="auto_annotation",
            status="pending",
            project_id=dataset.project_id,
            progress=0,
            task_metadata={
                "dataset_id": dataset_id,
                "dataset_name": dataset.name,
                "training_task_id": training_task_id,
                "training_task_name": training_task.name,
                "model_path": str(model_file),
                "checkpoint": checkpoint,
                "annotation_name": annotation_name,
                "conf_threshold": conf_threshold,
                "iou_threshold": iou_threshold,
                "use_segmentation": use_segmentation,
                "class_names": class_names,
                "num_classes": len(class_names),
                **(
                    {"collection_id": effective_collection_id}
                    if effective_collection_id is not None
                    else {}
                ),
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Start Celery task
        from app.tasks.auto_annotation_tasks import auto_annotate_yolo
        
        celery_task = auto_annotate_yolo.delay(
            task.id,
            str(model_file),
            dataset_id,
            class_names,
            annotation_name,
            conf_threshold,
            iou_threshold,
            use_segmentation
        )
        
        # Update task with Celery ID
        task.task_metadata = {
            **task.task_metadata,
            'celery_task_id': celery_task.id
        }
        db.commit()
        
        logger.info(f"Started auto-annotation task {task.id} from training task {training_task_id}")
        
        return {
            "success": True,
            "message": "Auto-annotation started",
            "task_id": task.id,
            "task_name": task.name,
            "num_classes": len(class_names),
            "class_names": class_names
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting auto-annotation: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start auto-annotation: {str(e)}")


@router.get("/auto-annotate/models")
async def list_available_models(
    project_id: int,
    db: Session = Depends(get_db)
):
    """
    List available models for auto-annotation (from completed training tasks)
    """
    try:
        # Get all completed training tasks for this project
        training_tasks = db.query(Task).filter(
            Task.project_id == project_id,
            Task.task_type == "training",
            Task.status == "completed"
        ).order_by(Task.completed_at.desc()).all()
        
        models = []
        
        for task in training_tasks:
            task_metadata = task.task_metadata or {}
            training_dir = Path("projects") / str(project_id) / "training" / f"task_{task.id}"
            weights_dir = training_dir / "weights"
            
            if weights_dir.exists():
                best_model = weights_dir / "best.pt"
                last_model = weights_dir / "last.pt"
                
                available_checkpoints = []
                if best_model.exists():
                    available_checkpoints.append("best")
                if last_model.exists():
                    available_checkpoints.append("last")
                
                if available_checkpoints:
                    models.append({
                        "task_id": task.id,
                        "task_name": task.name,
                        "model_type": task_metadata.get('model_type', 'Unknown'),
                        "class_names": task_metadata.get('class_names', []),
                        "num_classes": len(task_metadata.get('class_names', [])),
                        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
                        "available_checkpoints": available_checkpoints,
                        "weights_dir": str(weights_dir)
                    })
        
        return {
            "success": True,
            "models": models,
            "count": len(models)
        }
        
    except Exception as e:
        logger.error(f"Error listing models: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to list models: {str(e)}")
