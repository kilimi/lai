from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from pathlib import Path
import logging
import subprocess
import tempfile
import json
import onnxruntime as ort
import numpy as np
from PIL import Image
import cv2

from ..database import get_db
from .. import models
from pydantic import BaseModel as PydanticBaseModel

router = APIRouter()
logger = logging.getLogger(__name__)


class PipelineCreate(PydanticBaseModel):
    project_id: int
    name: str
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]


class PipelineResponse(PydanticBaseModel):
    id: int
    project_id: int
    name: str
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class PipelineStep(BaseModel):
    type: str  # 'areaThreshold', 'confidenceThreshold', etc.
    minArea: Optional[float] = None
    maxArea: Optional[float] = None
    minConfidence: Optional[float] = None


class PipelineRequest(BaseModel):
    modelId: int
    datasetId: int
    steps: List[PipelineStep]


def calculate_bbox_area(bbox: List[float]) -> float:
    """Calculate area of bounding box [x, y, width, height]"""
    return bbox[2] * bbox[3]


def run_model_inference(model_path: str, image_path: str) -> List[Dict[str, Any]]:
    """Run YOLO ONNX model inference on an image"""
    try:
        # Load ONNX model
        session = ort.InferenceSession(model_path)
        
        # Preprocess image
        img = cv2.imread(image_path)
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        original_shape = img_rgb.shape[:2]
        
        # Resize to model input size (640x640 for YOLO)
        target_size = (640, 640)
        scale = min(target_size[0] / original_shape[1], target_size[1] / original_shape[0])
        new_width = int(original_shape[1] * scale)
        new_height = int(original_shape[0] * scale)
        
        img_resized = cv2.resize(img_rgb, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
        img_padded = np.zeros((target_size[1], target_size[0], 3), dtype=np.uint8)
        img_padded[:new_height, :new_width] = img_resized
        
        # Normalize
        img_normalized = img_padded.astype(np.float32) / 255.0
        img_input = np.transpose(img_normalized, (2, 0, 1))
        img_input = np.expand_dims(img_input, axis=0)
        
        # Run inference
        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: img_input})
        output = outputs[0]
        
        # Postprocess output
        predictions = []
        if len(output.shape) == 3:
            output = output[0]
        
        if output.shape[1] > 4:
            boxes = output[:, :4]
            confidences = output[:, 4:5]
            class_scores = output[:, 5:]
            
            class_ids = np.argmax(class_scores, axis=1)
            class_confidences = np.max(class_scores, axis=1)
            final_confidences = confidences.flatten() * class_confidences
            
            # Filter by confidence threshold
            valid_indices = final_confidences > 0.25
            
            if np.any(valid_indices):
                boxes = boxes[valid_indices]
                final_confidences = final_confidences[valid_indices]
                class_ids = class_ids[valid_indices]
                
                # Convert to xyxy format and scale back
                x_center = boxes[:, 0]
                y_center = boxes[:, 1]
                width = boxes[:, 2]
                height = boxes[:, 3]
                
                x1 = (x_center - width / 2) / scale
                y1 = (y_center - height / 2) / scale
                x2 = (x_center + width / 2) / scale
                y2 = (y_center + height / 2) / scale
                
                # Clip to image bounds
                x1 = np.clip(x1, 0, original_shape[1])
                y1 = np.clip(y1, 0, original_shape[0])
                x2 = np.clip(x2, 0, original_shape[1])
                y2 = np.clip(y2, 0, original_shape[0])
                
                for i in range(len(x1)):
                    bbox = [float(x1[i]), float(y1[i]), float(x2[i] - x1[i]), float(y2[i] - y1[i])]
                    predictions.append({
                        'bbox': bbox,
                        'confidence': float(final_confidences[i]),
                        'class_id': int(class_ids[i]),
                    })
        
        return predictions
    except Exception as e:
        logger.error(f"Error running inference: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")


def apply_pipeline_steps(predictions: List[Dict[str, Any]], steps: List[PipelineStep]) -> List[Dict[str, Any]]:
    """Apply pipeline post-processing steps to predictions"""
    filtered = predictions.copy()
    
    for step in steps:
        if step.type == 'areaThreshold':
            filtered = [
                p for p in filtered
                if calculate_bbox_area(p['bbox']) >= (step.minArea or 0)
                and (step.maxArea is None or calculate_bbox_area(p['bbox']) <= step.maxArea)
            ]
        elif step.type == 'confidenceThreshold':
            filtered = [
                p for p in filtered
                if p['confidence'] >= (step.minConfidence or 0.25)
            ]
    
    return filtered


@router.post("/pipelines/execute")
async def execute_pipeline(
    request: PipelineRequest,
    db: Session = Depends(get_db)
):
    """
    Execute a pipeline: run model inference and apply post-processing steps.
    """
    try:
        # Get training task (model)
        training_task = db.query(models.Task).filter(
            models.Task.id == request.modelId,
            models.Task.task_type == 'yolo_training',
            models.Task.status == 'completed'
        ).first()
        
        if not training_task:
            raise HTTPException(status_code=404, detail="Training task not found or not completed")
        
        # Get dataset
        dataset = db.query(models.Dataset).filter(models.Dataset.id == request.datasetId).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Get exported ONNX model from export tasks
        # First, try to find an export task for this training task
        export_tasks = db.query(models.Task).filter(
            models.Task.task_type == 'model_export',
            models.Task.status == 'completed'
        ).all()
        
        onnx_model = None
        
        # Find export task that references this training task
        for export_task in export_tasks:
            if export_task.task_metadata and export_task.task_metadata.get('training_task_id') == request.modelId:
                exported_file = export_task.task_metadata.get('exported_file')
                if exported_file and Path(exported_file).exists():
                    onnx_model = Path(exported_file)
                    break
        
        # Fallback: try to find ONNX model in training task directory
        if not onnx_model or not onnx_model.exists():
            task_metadata = training_task.task_metadata or {}
            model_path = task_metadata.get('best_model') or task_metadata.get('last_model')
            
            if model_path and Path(model_path).exists():
                model_dir = Path(model_path).parent
                onnx_model = model_dir / f"{Path(model_path).stem}.onnx"
                
                if not onnx_model.exists():
                    onnx_model = model_dir / f"{Path(model_path).stem.replace('.pt', '')}.onnx"
                    if not onnx_model.exists():
                        onnx_model = Path(model_path).with_suffix('.onnx')
        
        if not onnx_model or not onnx_model.exists():
            raise HTTPException(
                status_code=404,
                detail="ONNX model not found. Please export the model first."
            )
        
        # Get dataset images
        images = db.query(models.Image).filter(models.Image.dataset_id == request.datasetId).all()
        
        if not images:
            raise HTTPException(status_code=400, detail="Dataset has no images")
        
        # Run inference on all images and apply pipeline steps
        all_predictions = []
        all_filtered = []
        
        for image in images[:10]:  # Limit to first 10 images for performance
            if not image.url or not Path(image.url).exists():
                continue
            
            # Run inference
            predictions = run_model_inference(str(onnx_model), image.url)
            all_predictions.extend(predictions)
            
            # Apply pipeline steps
            filtered = apply_pipeline_steps(predictions, request.steps)
            all_filtered.extend(filtered)
        
        return {
            "success": True,
            "total_detections": len(all_predictions),
            "filtered_detections": all_filtered,
            "images_processed": min(len(images), 10),
            "pipeline_steps": [step.dict() for step in request.steps],
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error executing pipeline: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Pipeline execution error: {str(e)}")


@router.get("/pipelines/")
async def list_pipelines(
    project_id: int,
    db: Session = Depends(get_db)
):
    """List all pipelines for a project"""
    pipelines = db.query(models.Pipeline).filter(
        models.Pipeline.project_id == project_id
    ).order_by(models.Pipeline.created_at.desc()).all()
    
    return {
        "pipelines": [
            {
                "id": p.id,
                "project_id": p.project_id,
                "name": p.name,
                "nodes": p.nodes or [],
                "edges": p.edges or [],
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in pipelines
        ]
    }


@router.post("/pipelines/")
async def create_pipeline(
    pipeline: PipelineCreate,
    db: Session = Depends(get_db)
):
    """Create a new pipeline"""
    # Verify project exists
    project = db.query(models.Project).filter(models.Project.id == pipeline.project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    db_pipeline = models.Pipeline(
        project_id=pipeline.project_id,
        name=pipeline.name,
        nodes=pipeline.nodes,
        edges=pipeline.edges,
    )
    db.add(db_pipeline)
    db.commit()
    db.refresh(db_pipeline)
    
    return {
        "id": db_pipeline.id,
        "project_id": db_pipeline.project_id,
        "name": db_pipeline.name,
        "nodes": db_pipeline.nodes or [],
        "edges": db_pipeline.edges or [],
        "created_at": db_pipeline.created_at.isoformat() if db_pipeline.created_at else None,
        "updated_at": db_pipeline.updated_at.isoformat() if db_pipeline.updated_at else None,
    }


@router.get("/pipelines/{pipeline_id}")
async def get_pipeline(
    pipeline_id: int,
    db: Session = Depends(get_db)
):
    """Get a specific pipeline"""
    pipeline = db.query(models.Pipeline).filter(models.Pipeline.id == pipeline_id).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    
    return {
        "id": pipeline.id,
        "project_id": pipeline.project_id,
        "name": pipeline.name,
        "nodes": pipeline.nodes or [],
        "edges": pipeline.edges or [],
        "created_at": pipeline.created_at.isoformat() if pipeline.created_at else None,
        "updated_at": pipeline.updated_at.isoformat() if pipeline.updated_at else None,
    }


@router.put("/pipelines/{pipeline_id}")
async def update_pipeline(
    pipeline_id: int,
    pipeline: PipelineCreate,
    db: Session = Depends(get_db)
):
    """Update a pipeline"""
    db_pipeline = db.query(models.Pipeline).filter(models.Pipeline.id == pipeline_id).first()
    if not db_pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    
    db_pipeline.name = pipeline.name
    db_pipeline.nodes = pipeline.nodes
    db_pipeline.edges = pipeline.edges
    db.commit()
    db.refresh(db_pipeline)
    
    return {
        "id": db_pipeline.id,
        "project_id": db_pipeline.project_id,
        "name": db_pipeline.name,
        "nodes": db_pipeline.nodes or [],
        "edges": db_pipeline.edges or [],
        "created_at": db_pipeline.created_at.isoformat() if db_pipeline.created_at else None,
        "updated_at": db_pipeline.updated_at.isoformat() if db_pipeline.updated_at else None,
    }


@router.delete("/pipelines/{pipeline_id}")
async def delete_pipeline(
    pipeline_id: int,
    db: Session = Depends(get_db)
):
    """Delete a pipeline"""
    pipeline = db.query(models.Pipeline).filter(models.Pipeline.id == pipeline_id).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    
    db.delete(pipeline)
    db.commit()
    
    return {"success": True, "message": "Pipeline deleted"}
