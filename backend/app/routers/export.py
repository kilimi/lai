from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from pathlib import Path
import logging
from datetime import datetime
import shutil
import os
import subprocess
import tempfile
import json
import uuid
import zipfile

from ..database import get_db
from .. import models
from app.task_dispatch import ensure_inline_dispatch_allowed

router = APIRouter()
logger = logging.getLogger(__name__)

# Check if Celery is available
USE_CELERY = os.environ.get('USE_CELERY', 'true').lower() == 'true'
celery_export_task = None

def _queue_export_task(export_task_id: int, export_config: dict):
    """Enqueue export on the GPU worker without importing ultralytics in the API process."""
    from app.ml.celery_dispatch import GPU_QUEUE, send_gpu_task

    return send_gpu_task(
        "app.tasks.export_tasks.export_yolo_model",
        args=[export_task_id, export_config],
        queue=GPU_QUEUE,
    )


if USE_CELERY:
    logger.info("Celery task queue enabled for exports (GPU worker)")


class ExportRequest(BaseModel):
    """Request model for exporting a model. Use either task_id (trained) or model_name (foundation)."""
    task_id: Optional[int] = None  # Training task ID (for trained models)
    model_name: Optional[str] = None  # Foundation model name, e.g. yolo11n, yolo26s (for pre-trained)
    checkpoint: str = "best"  # "best" or "last" (only for task_id)
    export_format: str = "onnx"  # Currently only "onnx" supported
    task_name: Optional[str] = None
    project_id: Optional[int] = None  # Optional project for foundation export (for UI grouping)
    # ONNX export parameters
    half: bool = False  # FP16 quantization
    imgsz: Optional[int] = 640  # Image size (height/width)
    simplify: bool = False  # Simplify ONNX model
    opset: Optional[int] = None  # ONNX opset version
    dynamic: bool = False  # Dynamic axes
    workspace: Optional[int] = None  # Workspace size in MB


@router.post("/export/yolo/start")
async def start_yolo_export(
    request: ExportRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Start converting a YOLO model to ONNX format.
    Source: Trained model (task_id) or Foundation model (model_name, same as Auto-Annotate).
    Creates a background task for the conversion process.
    """
    try:
        if request.model_name:
            # Foundation model export (pre-trained from Ultralytics hub)
            task_name = request.task_name or f"Export {request.model_name} to {request.export_format.upper()}"
            export_task = models.Task(
                project_id=request.project_id,
                name=task_name,
                task_type="model_export",
                status="pending",
                task_metadata={
                    "model_name": request.model_name,
                    "export_format": request.export_format,
                    "source": "foundation",
                }
            )
            db.add(export_task)
            db.commit()
            db.refresh(export_task)
            export_config = {
                "model_name": request.model_name,
                "export_format": request.export_format,
                "output_dir": str((Path("backups") / "exports").resolve()),
                "half": request.half,
                "imgsz": request.imgsz,
                "simplify": request.simplify,
                "opset": request.opset,
                "dynamic": request.dynamic,
                "workspace": request.workspace,
            }
        elif request.task_id is not None:
            # Trained model export
            training_task = db.query(models.Task).filter(
                models.Task.id == request.task_id,
                models.Task.task_type.in_(['yolo_training', 'training'])
            ).first()
            
            if not training_task:
                raise HTTPException(status_code=404, detail="Training task not found")
            
            if training_task.status != 'completed':
                raise HTTPException(
                    status_code=400, 
                    detail=f"Training task must be completed. Current status: {training_task.status}"
                )
            
            task_metadata = training_task.task_metadata or {}
            model_path = None
            
            if request.checkpoint == "best":
                model_path = task_metadata.get('best_model')
            else:
                last_model = task_metadata.get('last_model')
                if last_model:
                    model_path = last_model
                elif task_metadata.get('results_dir'):
                    model_path = str(Path(task_metadata['results_dir']) / "weights" / "last.pt")
            
            if not model_path or not Path(model_path).exists():
                raise HTTPException(
                    status_code=404,
                    detail=f"Model checkpoint '{request.checkpoint}' not found at {model_path}"
                )
            
            task_name = request.task_name or f"Export {training_task.name} - {request.checkpoint} to {request.export_format.upper()}"
            export_task = models.Task(
                project_id=training_task.project_id,
                name=task_name,
                task_type="model_export",
                status="pending",
                task_metadata={
                    "training_task_id": request.task_id,
                    "model_path": model_path,
                    "checkpoint": request.checkpoint,
                    "export_format": request.export_format,
                    "original_task_name": training_task.name,
                    "source": "trained",
                }
            )
            db.add(export_task)
            db.commit()
            db.refresh(export_task)
            export_config = {
                "model_path": model_path,
                "checkpoint": request.checkpoint,
                "export_format": request.export_format,
                "training_task_id": request.task_id,
                "output_dir": str(Path(training_task.task_metadata.get('results_dir', '.')) / "exports"),
                "half": request.half,
                "imgsz": request.imgsz,
                "simplify": request.simplify,
                "opset": request.opset,
                "dynamic": request.dynamic,
                "workspace": request.workspace,
            }
        else:
            raise HTTPException(
                status_code=400,
                detail="Provide either task_id (trained model) or model_name (foundation model)."
            )
        
        # Start export in background
        if USE_CELERY:
            # Use Celery for proper task queuing
            celery_task = _queue_export_task(export_task.id, export_config)
            logger.info(f"Queued export task {export_task.id} in Celery (task_id: {celery_task.id})")
            
            # Store Celery task ID in metadata
            export_task.task_metadata = {
                **export_task.task_metadata,
                "celery_task_id": celery_task.id
            }
            db.commit()
        else:
            ensure_inline_dispatch_allowed("Model export")
        
        return {
            "success": True,
            "task_id": export_task.id,
            "message": "Export started",
            "data": {
                "task_id": export_task.id,
                "name": export_task.name,
                "status": export_task.status
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting export: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error starting export: {str(e)}")


# Background task function removed - now using Celery task in app.tasks.export_tasks


@router.get("/export/download/{task_id}")
async def download_exported_model(
    task_id: int,
    db: Session = Depends(get_db)
):
    """
    Download an exported model file.
    """
    task = db.query(models.Task).filter(
        models.Task.id == task_id,
        models.Task.task_type == 'model_export'
    ).first()
    
    if not task:
        raise HTTPException(status_code=404, detail="Export task not found")
    
    if task.status != 'completed':
        raise HTTPException(
            status_code=400,
            detail=f"Export task is not completed. Current status: {task.status}"
        )
    
    task_metadata = task.task_metadata or {}
    exported_file = task_metadata.get('exported_file')
    onnx_file = task_metadata.get('onnx_file')
    
    logger.info(f"Download request for task {task_id}, exported_file in metadata: {exported_file}")
    
    # Check if we have a zip file, otherwise try to create one from the ONNX file.
    # Also recover when exported_file points to a stale or missing path.
    if not exported_file:
        logger.info(f"No exported_file, trying onnx_file: {onnx_file}")
        if onnx_file and Path(onnx_file).exists():
            # Create zip file on-demand for old exports
            exported_file = _create_zip_from_onnx(Path(onnx_file), task_metadata.get('class_names', []))
            if exported_file:
                # Update task metadata with zip file
                task_metadata['exported_file'] = str(exported_file)
                task.task_metadata = task_metadata
                db.commit()
                logger.info(f"Created zip file on-demand: {exported_file}")
            else:
                raise HTTPException(status_code=404, detail="Exported file not found in task metadata")
    else:
        # Check if exported_file is an ONNX file (old format) and create zip if needed
        file_path_check = Path(exported_file)
        logger.info(f"Checking exported_file: {exported_file}, exists: {file_path_check.exists()}, suffix: {file_path_check.suffix}")
        if not file_path_check.exists():
            logger.warning(f"Exported file path is stale or missing, trying onnx_file fallback: {onnx_file}")
            if onnx_file and Path(onnx_file).exists():
                zip_file = _create_zip_from_onnx(Path(onnx_file), task_metadata.get('class_names', []))
                if zip_file:
                    task_metadata['exported_file'] = str(zip_file)
                    task.task_metadata = task_metadata
                    db.commit()
                    exported_file = str(zip_file)
                    logger.info(f"Recreated zip file from ONNX after stale exported_file path: {zip_file}")
        elif file_path_check.suffix.lower() == '.onnx':
            # It's an ONNX file, create zip from it
            logger.info(f"Exported file is ONNX, creating zip file...")
            zip_file = _create_zip_from_onnx(file_path_check, task_metadata.get('class_names', []))
            if zip_file:
                # Update task metadata with zip file
                task_metadata['exported_file'] = str(zip_file)
                task.task_metadata = task_metadata
                db.commit()
                exported_file = str(zip_file)
                logger.info(f"Created zip file from ONNX for download: {zip_file}")
        elif file_path_check.suffix.lower() == '.zip':
            logger.info(f"Exported file is already a zip file: {exported_file}")
        else:
            logger.warning(f"Exported file path exists but is neither ONNX nor ZIP: {exported_file}")
    
    file_path = Path(exported_file)
    if not file_path.exists():
        logger.error(f"Exported file does not exist: {exported_file}")
        raise HTTPException(status_code=404, detail=f"Exported file not found at {exported_file}")
    
    logger.info(f"Serving file: {file_path} (size: {file_path.stat().st_size if file_path.exists() else 0} bytes)")
    
    # Check if it's a zip file (new format) or ONNX file (old format)
    import re
    task_name = task.name or f"export_{task_id}"
    # Remove invalid filename characters and replace with underscore
    sanitized_name = re.sub(r'[<>:"/\\|?*]', '_', task_name)
    # Remove leading/trailing spaces and dots
    sanitized_name = sanitized_name.strip('. ')
    
    # Check file extension
    if file_path.suffix.lower() == '.zip':
        # It's a zip file - use .zip extension
        if not sanitized_name.lower().endswith('.zip'):
            sanitized_name = f"{sanitized_name}.zip"
        media_type = 'application/zip'
    else:
        # It's an ONNX file (old format) - use .onnx extension
        if not sanitized_name.lower().endswith('.onnx'):
            sanitized_name = f"{sanitized_name}.onnx"
        media_type = 'application/octet-stream'
    
    return FileResponse(
        path=str(file_path),
        filename=sanitized_name,
        media_type=media_type
    )


def _create_zip_from_onnx(onnx_path: Path, class_names: List[str]) -> Optional[Path]:
    """Create a zip file from an existing ONNX file (for backward compatibility with old exports)"""
    try:
        from app.tasks.export_tasks import _create_inference_script, _create_readme
        
        output_dir = onnx_path.parent
        zip_filename = onnx_path.stem + '.zip'
        zip_path = output_dir / zip_filename
        
        # Check if zip already exists
        if zip_path.exists():
            logger.info(f"Zip file already exists: {zip_path}")
            return zip_path
        
        # Load class names from JSON file if available
        classes_file = Path(str(onnx_path) + '.classes.json')
        if classes_file.exists():
            with open(classes_file, 'r') as f:
                classes_data = json.load(f)
                class_names = classes_data.get('class_names', class_names)
        
        # Create zip file
        inference_script = _create_inference_script(class_names)
        readme_content = _create_readme(onnx_path.name, class_names)
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Add ONNX model
            zipf.write(onnx_path, onnx_path.name)
            logger.info(f"Added {onnx_path.name} to zip")
            
            # Add class names JSON if available
            if classes_file.exists():
                zipf.write(classes_file, 'classes.json')
                logger.info(f"Added classes.json to zip")
            elif class_names:
                # Create classes.json from class_names
                classes_data = {
                    'class_names': class_names,
                    'num_classes': len(class_names),
                    'exported_at': datetime.utcnow().isoformat()
                }
                zipf.writestr('classes.json', json.dumps(classes_data, indent=2))
                logger.info(f"Added classes.json to zip (created from class_names)")
            
            # Add inference script
            zipf.writestr('run_inference.py', inference_script)
            logger.info(f"Added run_inference.py to zip")
            
            # Add README
            zipf.writestr('README.md', readme_content)
            logger.info(f"Added README.md to zip")
        
        logger.info(f"Created zip file from ONNX: {zip_path}")
        return zip_path
        
    except Exception as e:
        logger.error(f"Failed to create zip file from ONNX: {e}", exc_info=True)
        return None


@router.post("/export/test-inference")
async def test_onnx_inference(
    image: UploadFile = File(...),
    onnx_file_path: str = Form(...),
    task_id: int = Form(...),
    db: Session = Depends(get_db)
):
    """
    Test ONNX model inference on an uploaded image.
    Returns predictions with bounding boxes and confidence scores.
    """
    try:
        # Verify the export task exists
        task = db.query(models.Task).filter(
            models.Task.id == task_id,
            models.Task.task_type == 'model_export'
        ).first()
        
        if not task:
            raise HTTPException(status_code=404, detail="Export task not found")
        
        if task.status != 'completed':
            raise HTTPException(
                status_code=400,
                detail=f"Export task is not completed. Current status: {task.status}"
            )
        
        task_metadata = task.task_metadata or {}

        # Resolve requested path first, then fall back to task metadata if the zip moved
        # or was never created but the raw ONNX still exists.
        def _resolve_existing_export_path(path_value: Optional[str]) -> Optional[Path]:
            if not path_value:
                return None
            candidate = Path(path_value)
            if not candidate.is_absolute():
                candidate = candidate.resolve()
            return candidate if candidate.exists() else None

        requested_path = Path(onnx_file_path)
        onnx_path = requested_path if requested_path.is_absolute() else requested_path.resolve()
        extracted_onnx_path = None

        logger.info(f"Processing ONNX file path: {onnx_file_path} -> resolved: {onnx_path}, exists: {onnx_path.exists()}, suffix: {onnx_path.suffix}")

        if not onnx_path.exists():
            fallback_zip = _resolve_existing_export_path(task_metadata.get('exported_file'))
            fallback_onnx = _resolve_existing_export_path(task_metadata.get('onnx_file'))
            if fallback_zip is not None:
                logger.info(f"Requested export path missing; falling back to task exported_file: {fallback_zip}")
                onnx_path = fallback_zip
            elif fallback_onnx is not None:
                logger.info(f"Requested export path missing; falling back to task onnx_file: {fallback_onnx}")
                onnx_path = fallback_onnx
        
        # If the path is a zip file, extract the ONNX file from it
        if onnx_path.suffix.lower() == '.zip':
            if not onnx_path.exists():
                fallback_onnx = _resolve_existing_export_path(task_metadata.get('onnx_file'))
                if fallback_onnx is not None:
                    logger.info(f"Zip file missing; using fallback ONNX path {fallback_onnx}")
                    onnx_path = fallback_onnx
                else:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Zip file not found at {onnx_file_path}"
                    )
            
            if onnx_path.suffix.lower() == '.zip':
                # Extract ONNX file from zip
                try:
                    import zipfile
                    with zipfile.ZipFile(onnx_path, 'r') as zipf:
                        # Find ONNX file in zip
                        onnx_files = [f for f in zipf.namelist() if f.endswith('.onnx')]
                        if not onnx_files:
                            raise HTTPException(
                                status_code=400,
                                detail=f"No ONNX file found in zip archive {onnx_file_path}"
                            )
                        
                        # Use the first ONNX file found
                        onnx_filename = onnx_files[0]
                        
                        # Extract to temporary directory
                        temp_dir = Path(tempfile.gettempdir()) / f"onnx_extract_{uuid.uuid4().hex[:8]}"
                        temp_dir.mkdir(exist_ok=True)
                        extracted_onnx_path = temp_dir / onnx_filename
                        
                        # Extract the file
                        with zipf.open(onnx_filename) as source, open(extracted_onnx_path, 'wb') as target:
                            target.write(source.read())
                        
                        logger.info(f"Extracted ONNX file from zip: {onnx_filename} -> {extracted_onnx_path}")
                        onnx_path = extracted_onnx_path
                except zipfile.BadZipFile:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid zip file at {onnx_file_path}"
                    )
                except Exception as e:
                    logger.error(f"Failed to extract ONNX from zip: {e}", exc_info=True)
                    raise HTTPException(
                        status_code=500,
                        detail=f"Failed to extract ONNX file from zip: {str(e)}"
                    )
        elif not onnx_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"ONNX file not found at {onnx_file_path}"
            )
        
        # Get class names - try to load from zip file or JSON file alongside ONNX file
        class_names = []
        original_onnx_path = Path(onnx_file_path)  # Keep original path for class file lookup
        
        # If we extracted from zip, try to get class names from zip
        if extracted_onnx_path and original_onnx_path.suffix.lower() == '.zip':
            try:
                import zipfile
                with zipfile.ZipFile(original_onnx_path, 'r') as zipf:
                    # Try to find classes.json in zip
                    if 'classes.json' in zipf.namelist():
                        with zipf.open('classes.json') as f:
                            classes_data = json.load(f)
                            class_names = classes_data.get('class_names', [])
                            logger.info(f"Loaded {len(class_names)} class names from zip file")
            except Exception as e:
                logger.warning(f"Failed to load class names from zip: {e}")
        
        # Try loading from JSON file alongside original file
        if not class_names:
            classes_file = Path(str(original_onnx_path) + '.classes.json')
            if classes_file.exists():
                try:
                    with open(classes_file, 'r') as f:
                        classes_data = json.load(f)
                        class_names = classes_data.get('class_names', [])
                        logger.info(f"Loaded {len(class_names)} class names from {classes_file}")
                except Exception as e:
                    logger.warning(f"Failed to load class names from {classes_file}: {e}")
        
        # Fallback to database lookup if JSON file doesn't exist or failed
        if not class_names:
            training_task_id = task_metadata.get('training_task_id')
            
            if training_task_id:
                training_task = db.query(models.Task).filter(
                    models.Task.id == training_task_id
                ).first()
                if training_task and training_task.task_metadata:
                    class_names = training_task.task_metadata.get('class_names', [])
                    logger.info(f"Loaded {len(class_names)} class names from database")
        
        # Save uploaded image to temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp_image:
            tmp_image_path = tmp_image.name
            content = await image.read()
            tmp_image.write(content)
        
        try:
            # Create temporary output directory
            output_dir = Path(tempfile.gettempdir()) / f"inference_{uuid.uuid4().hex[:8]}"
            output_dir.mkdir(exist_ok=True)
            
            # Create Python script for inference
            script_path = output_dir / "run_inference.py"
            result_json_path = output_dir / "results.json"
            annotated_image_path = output_dir / "annotated.jpg"
            
            # Cleanup extracted ONNX file after inference if it was extracted from zip
            cleanup_extracted = extracted_onnx_path is not None
            
            # Generate the inference script with custom ONNX postprocessing
            inference_script = """import onnxruntime as ort
import numpy as np
import cv2
import json
import sys

def preprocess_image(image_path, target_size=(640, 640)):
    '''Preprocess image for YOLO ONNX model'''
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image from {image_path}")
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    original_shape = img_rgb.shape[:2]  # (height, width)
    try:
        tw = int(target_size[0]) if target_size[0] is not None else 640
    except (TypeError, ValueError):
        tw = 640
    try:
        th = int(target_size[1]) if target_size[1] is not None else 640
    except (TypeError, ValueError):
        th = 640
    target_size = (tw, th)
    # Resize maintaining aspect ratio
    scale = min(target_size[0] / original_shape[1], target_size[1] / original_shape[0])
    new_width = int(original_shape[1] * scale)
    new_height = int(original_shape[0] * scale)
    
    img_resized = cv2.resize(img_rgb, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
    
    # Pad to target size (padding is added to bottom/right, so offset is 0,0)
    img_padded = np.zeros((target_size[1], target_size[0], 3), dtype=np.uint8)
    img_padded[:new_height, :new_width] = img_resized
    
    # Normalize to [0, 1] and convert to float32
    img_normalized = img_padded.astype(np.float32) / 255.0
    
    # Convert to NCHW format
    img_input = np.transpose(img_normalized, (2, 0, 1))
    img_input = np.expand_dims(img_input, axis=0)
    
    # Return scale and resized dimensions for coordinate transformation
    # Note: padding offset is always (0, 0) since we pad to top-left
    return img_input, original_shape, scale, img, (new_width, new_height)

def postprocess_yolo_output(output, original_shape, scale, conf_threshold=0.25, iou_threshold=0.45, class_names=None, resized_size=None, masks_output=None):
    '''Postprocess YOLO ONNX output to get bounding boxes and masks'''
    predictions = []
    
    # YOLO ONNX output format: [batch, num_detections, features]
    # Features: [x_center, y_center, width, height, conf, class_scores...]
    # Coordinates are in model input space (640x640), NOT normalized
    
    # Remove batch dimension if present
    if len(output.shape) == 3:
        output = output[0]  # [num_detections, features]
    
    # Check if output is transposed (features first)
    if len(output.shape) == 2 and output.shape[0] < output.shape[1] and output.shape[0] <= 100:
        # Likely transposed: [features, num_detections] -> transpose to [num_detections, features]
        output = output.T
    
    # Now output should be [num_detections, features]
    num_detections = output.shape[0]
    num_features = output.shape[1]
    
    print(f"Output shape after processing: {output.shape} (detections={num_detections}, features={num_features})")
    
    if num_features < 5:
        print(f"Error: Unexpected output shape {output.shape}, expected at least 5 features")
        print(f"Sample output values: {output[:3, :] if num_detections >= 3 else output}")
        return predictions
    
    if num_detections == 0:
        print("Error: No detections in output")
        return predictions
    
    # Extract boxes (first 4 values)
    boxes = output[:, :4]  # [num_detections, 4]
    
    # Detect output layout: Ultralytics YOLOv8/v11/v26 use [bbox(4), class_scores(N)] with NO objectness.
    # Legacy format is [bbox(4), objectness(1), class_scores(N)]. Confidence = max(class_scores) for Ultralytics.
    num_expected_classes = len(class_names) if class_names else None
    has_objectness = True  # legacy default
    if num_expected_classes is not None:
        if num_features == 4 + num_expected_classes:
            has_objectness = False  # Ultralytics format
            print(f"Using Ultralytics format (bbox + {num_expected_classes} class scores, no objectness)")
        elif num_features == 5 + num_expected_classes:
            has_objectness = True
            print(f"Using legacy format (bbox + objectness + {num_expected_classes} class scores)")
    
    num_classes = (num_features - 4) if not has_objectness else (num_features - 5)
    mask_coeffs = None
    if has_objectness and masks_output is not None and num_features > 37:
        if num_features >= 37 + 32:
            num_classes = num_features - 5 - 32
            mask_coeffs = output[:, 5 + num_classes:5 + num_classes + 32]
            print(f"Detected mask coefficients. Shape: {mask_coeffs.shape}")
        elif num_features == 37:
            num_classes = 32
    
    if not has_objectness:
        class_scores = output[:, 4:4 + num_classes]  # [num_detections, num_classes]
        raw_confidence = np.max(class_scores, axis=1)  # Ultralytics: confidence = max(class_scores)
    else:
        class_scores = output[:, 5:5 + num_classes]  # [num_detections, num_classes]
        raw_confidence = output[:, 4]  # objectness or combined confidence
    
    if len(boxes) > 0:
        print(f"Sample box values (first detection): {boxes[0]}")
        print(f"Box value ranges: min={np.min(boxes, axis=0)}, max={np.max(boxes, axis=0)}")
    print(f"Class scores shape: {class_scores.shape} (num_detections={class_scores.shape[0]}, num_classes={class_scores.shape[1]})")
    if class_scores.shape[0] > 0:
        print(f"Sample class scores (first detection): {class_scores[0, :10] if class_scores.shape[1] >= 10 else class_scores[0]}")
    print(f"Raw confidence range: min={np.min(raw_confidence) if len(raw_confidence) > 0 else 'N/A'}, max={np.max(raw_confidence) if len(raw_confidence) > 0 else 'N/A'}")
    
    # Apply softmax to class scores if they look like logits (values can be negative or > 1)
    # Check if class scores need softmax
    if np.any(class_scores < 0) or np.any(class_scores > 1.5):
        # Apply softmax to convert logits to probabilities
        exp_scores = np.exp(class_scores - np.max(class_scores, axis=1, keepdims=True))
        class_scores = exp_scores / np.sum(exp_scores, axis=1, keepdims=True)
        print("Applied softmax to class scores")
    
    # Get class with highest score for each detection
    # IMPORTANT: Only consider the first N classes where N = number of class names
    # This handles cases where ONNX model has more output classes than training classes
    num_expected_classes = len(class_names) if class_names else class_scores.shape[1]
    if class_scores.shape[1] > num_expected_classes and num_expected_classes > 0:
        print(f"WARNING: Model has {class_scores.shape[1]} output classes but only {num_expected_classes} class names. Using first {num_expected_classes} classes.")
        class_scores = class_scores[:, :num_expected_classes]
    elif class_scores.shape[1] < num_expected_classes:
        print(f"WARNING: Model has {class_scores.shape[1]} output classes but {num_expected_classes} class names. This is unusual.")
    
    class_ids = np.argmax(class_scores, axis=1)  # [num_detections]
    class_confidences = np.max(class_scores, axis=1)  # [num_detections]
    
    print(f"Class IDs from argmax: {class_ids[:10] if len(class_ids) >= 10 else class_ids}")
    print(f"Class IDs range: min={np.min(class_ids) if len(class_ids) > 0 else 'N/A'}, max={np.max(class_ids) if len(class_ids) > 0 else 'N/A'}")
    print(f"Expected class names count: {len(class_names) if class_names else 'N/A'}")
    
    # Confidence: Ultralytics uses max(class_scores); legacy uses 5th value (objectness or combined)
    if not has_objectness:
        final_confidences = np.clip(class_confidences.copy(), 0.0, 1.0)
        print(f"Using max(class_scores) as confidence (Ultralytics format)")
    else:
        if np.any(raw_confidence < 0) or np.any(raw_confidence > 1.5):
            final_confidences = 1.0 / (1.0 + np.exp(-raw_confidence))  # Sigmoid
            print(f"Applied sigmoid to confidence (raw range: [{np.min(raw_confidence):.4f}, {np.max(raw_confidence):.4f}])")
        else:
            final_confidences = raw_confidence.copy()
            print(f"Using confidence directly (already in 0-1 range)")
    
    # Clamp confidence to 0-1 range
    final_confidences = np.clip(final_confidences, 0.0, 1.0)
    
    print(f"Final confidences: min={np.min(final_confidences):.4f}, max={np.max(final_confidences):.4f}, mean={np.mean(final_confidences):.4f}")
    print(f"Class confidences: min={np.min(class_confidences):.4f}, max={np.max(class_confidences):.4f}, mean={np.mean(class_confidences):.4f}")
    
    # Filter by confidence threshold
    valid_indices = final_confidences > conf_threshold
    
    print(f"Total detections: {len(final_confidences)}")
    if len(final_confidences) > 0:
        print(f"Confidences range: min={np.min(final_confidences):.4f}, max={np.max(final_confidences):.4f}, mean={np.mean(final_confidences):.4f}")
        print(f"Valid indices (conf > {conf_threshold}): {np.sum(valid_indices)}")
    
    if not np.any(valid_indices):
        print(f"Warning: No detections passed confidence threshold {conf_threshold}")
        # Try with lower threshold to see if we get any results
        low_threshold = 0.01
        valid_indices_low = final_confidences > low_threshold
        if np.any(valid_indices_low):
            print(f"Found {np.sum(valid_indices_low)} detections with lower threshold {low_threshold}, using that instead")
            valid_indices = valid_indices_low
            conf_threshold = low_threshold
        else:
            print("No detections found even with very low threshold")
            return predictions
    
    # Store original indices before filtering (for mask mapping)
    # original_indices[i] gives the original detection index for the i-th filtered detection
    original_indices = np.where(valid_indices)[0]  # Get the original indices that passed confidence threshold
    
    # Filter valid predictions
    boxes = boxes[valid_indices]
    final_confidences = final_confidences[valid_indices]
    class_ids = class_ids[valid_indices]
    
    print(f"After confidence filtering: {len(boxes)} detections (from {num_detections} total)")
    print(f"Original indices mapping: {original_indices[:10] if len(original_indices) >= 10 else original_indices}")
    
    # Ultralytics ONNX can output either [x1, y1, x2, y2] (xyxy) or [x_center, y_center, w, h] (xywh), often normalized 0-1
    first_box = boxes[0]
    box_max = np.max(boxes, axis=0)
    box_min = np.min(boxes, axis=0)
    print(f"Box coordinate ranges: min={box_min}, max={box_max}")
    
    is_normalized = (box_max[0] <= 1.0 and box_max[1] <= 1.0 and 
                     box_max[2] <= 1.0 and box_max[3] <= 1.0 and
                     box_min[0] >= 0.0 and box_min[1] >= 0.0)
    print(f"Format detection: normalized={is_normalized}")
    
    # Detect xyxy: Ultralytics often exports [x1, y1, x2, y2]; xywh has (x_center, y_center, w, h) with w,h > 0 and x2 > x1, y2 > y1 only as corners
    use_xyxy = False
    if not has_objectness and len(boxes) > 0:
        # xyxy: second pair (x2,y2) should be greater than first (x1,y1) for valid boxes
        xyxy_like = np.mean((boxes[:, 2] > boxes[:, 0]) & (boxes[:, 3] > boxes[:, 1]))
        if xyxy_like > 0.5:
            use_xyxy = True
            print("Using xyxy bbox format (x1, y1, x2, y2)")
    
    model_input_size = 640
    if use_xyxy:
        x1_norm = boxes[:, 0]
        y1_norm = boxes[:, 1]
        x2_norm = boxes[:, 2]
        y2_norm = boxes[:, 3]
        if is_normalized:
            x1_model = x1_norm * model_input_size
            y1_model = y1_norm * model_input_size
            x2_model = x2_norm * model_input_size
            y2_model = y2_norm * model_input_size
            print("Converted normalized xyxy to pixel space (640x640)")
        else:
            x1_model = x1_norm
            y1_model = y1_norm
            x2_model = x2_norm
            y2_model = y2_norm
            print("Using xyxy coordinates in pixel space")
    else:
        # Center-wh: [x_center, y_center, width, height]
        x_center_norm = boxes[:, 0]
        y_center_norm = boxes[:, 1]
        width_norm = boxes[:, 2]
        height_norm = boxes[:, 3]
        if is_normalized:
            x_center = x_center_norm * model_input_size
            y_center = y_center_norm * model_input_size
            width = width_norm * model_input_size
            height = height_norm * model_input_size
            print("Converted normalized xywh to pixel space (640x640)")
        else:
            x_center = x_center_norm
            y_center = y_center_norm
            width = width_norm
            height = height_norm
            print("Coordinates already in pixel space (xywh)")
        x1_model = x_center - width / 2
        y1_model = y_center - height / 2
        x2_model = x_center + width / 2
        y2_model = y_center + height / 2
    
    print(f"After format conversion - x1_model range: [{np.min(x1_model):.1f}, {np.max(x1_model):.1f}]")
    print(f"After format conversion - y1_model range: [{np.min(y1_model):.1f}, {np.max(y1_model):.1f}]")
    
    # Scale back to original image coordinates
    # Coordinates are in model input space (640x640), but the actual image was resized
    # We need to scale from model space to original image space
    
    if resized_size:
        resized_width, resized_height = resized_size
        print(f"Resized image size: {resized_width}x{resized_height}, scale: {scale:.4f}")
        print(f"Original image size: {original_shape[1]}x{original_shape[0]}")
        
        # Clip to resized image bounds (exclude padding area) before scaling
        x1_model = np.clip(x1_model, 0, resized_width)
        y1_model = np.clip(y1_model, 0, resized_height)
        x2_model = np.clip(x2_model, 0, resized_width)
        y2_model = np.clip(y2_model, 0, resized_height)
    
    # Scale from model input space (resized) to original image space
    # scale = min(640 / original_width, 640 / original_height)
    # So: original_coord = model_coord / scale
    x1 = x1_model / scale
    y1 = y1_model / scale
    x2 = x2_model / scale
    y2 = y2_model / scale
    
    # Final clip to original image bounds
    x1 = np.clip(x1, 0, original_shape[1])
    y1 = np.clip(y1, 0, original_shape[0])
    x2 = np.clip(x2, 0, original_shape[1])
    y2 = np.clip(y2, 0, original_shape[0])
    
    print(f"Original image size: {original_shape[1]}x{original_shape[0]}")
    if len(x1) > 0:
        print(f"Sample scaled coordinates: x1={x1[0]:.1f}, y1={y1[0]:.1f}, x2={x2[0]:.1f}, y2={y2[0]:.1f}")
    
    # Prepare boxes for NMS (format: x, y, w, h)
    boxes_for_nms = np.column_stack([x1, y1, x2 - x1, y2 - y1])
    
    # Apply NMS
    indices = cv2.dnn.NMSBoxes(
        boxes_for_nms.tolist(),
        final_confidences.tolist(),
        conf_threshold,
        iou_threshold
    )
    
    print(f"After NMS: {len(indices) if len(indices) > 0 else 0} predictions")
    
    if len(indices) > 0:
        # Get the indices that passed NMS
        nms_indices = indices.flatten()
        
        # Extract masks if available
        masks_data = None
        prototype_masks = None
        if masks_output is not None:
            try:
                # Masks output shape can be:
                # - [batch, num_detections, mask_height, mask_width]
                # - [num_detections, mask_height, mask_width]
                # - [num_detections, num_prototypes, mask_height, mask_width] (YOLO segmentation)
                # - [num_prototypes, mask_height, mask_width] (prototype masks)
                print(f"Raw masks output shape: {masks_output.shape}")
                print(f"Raw masks output dtype: {masks_output.dtype}")
                print(f"Raw masks output sample values (min/max): {np.min(masks_output)}, {np.max(masks_output)}")
                
                if len(masks_output.shape) == 4:
                    if masks_output.shape[0] == 1:
                        # Has batch dimension, remove it
                        masks_3d = masks_output[0]  # [num_detections, mask_height, mask_width] or [num_prototypes, mask_height, mask_width] or [num_detections, num_prototypes, mask_height, mask_width]
                    else:
                        # No batch dimension
                        masks_3d = masks_output
                    
                    # Check the shape after removing batch dimension
                    if len(masks_3d.shape) == 3:
                        # Shape: [num_prototypes, mask_height, mask_width] or [num_detections, mask_height, mask_width]
                        if masks_3d.shape[0] <= 64:  # Likely prototype masks (typically 32)
                            # This is prototype masks
                            prototype_masks = masks_3d  # [num_prototypes, mask_height, mask_width]
                            masks_data = None
                            print(f"Prototype masks detected (4D->3D). Shape: {prototype_masks.shape} (num_prototypes={prototype_masks.shape[0]})")
                            print(f"Will need mask coefficients from detection output to combine prototypes")
                        elif masks_3d.shape[0] == len(output):
                            # Matches number of detections - direct per-detection masks
                            masks_data = masks_3d
                            print(f"Direct per-detection masks (4D->3D). Shape: {masks_data.shape}")
                        else:
                            print(f"Warning: 3D masks shape {masks_3d.shape} doesn't match detections {len(output)} and doesn't look like prototypes")
                            masks_data = None
                            prototype_masks = None
                    elif len(masks_3d.shape) == 4:
                        # Shape: [num_detections, num_prototypes, mask_height, mask_width]
                        # This is per-detection prototype masks
                        print(f"Per-detection prototype masks detected. Shape: {masks_3d.shape}")
                        # For now, use first prototype for each detection (would need mask coefficients for proper combination)
                        masks_data = masks_3d[:, 0, :, :]  # [num_detections, mask_height, mask_width]
                        print(f"Using first prototype for each detection. Processed shape: {masks_data.shape}")
                    else:
                        print(f"Warning: Unexpected masks shape after batch removal: {masks_3d.shape}")
                        masks_data = None
                        prototype_masks = None
                elif len(masks_output.shape) == 3:
                    # Shape: [num_prototypes, mask_height, mask_width] or [num_detections, mask_height, mask_width]
                    # Check if it matches number of detections
                    if masks_output.shape[0] == len(output):
                        # Matches number of detections - direct per-detection masks
                        masks_data = masks_output
                        print(f"Using 3D masks output directly. Shape: {masks_data.shape}")
                    elif masks_output.shape[0] <= 64:  # Likely prototype masks (typically 32)
                        # This is prototype masks - need mask coefficients to combine them
                        prototype_masks = masks_output  # [num_prototypes, mask_height, mask_width]
                        masks_data = None
                        print(f"Prototype masks detected. Shape: {prototype_masks.shape} (num_prototypes={prototype_masks.shape[0]})")
                        print(f"Will need mask coefficients from detection output to combine prototypes")
                    else:
                        print(f"Warning: 3D masks output shape {masks_output.shape} doesn't match detections {len(output)}")
                        masks_data = None
                        prototype_masks = None
                else:
                    print(f"Warning: Unexpected masks output shape: {masks_output.shape}")
                    masks_data = None
            except Exception as e:
                import traceback
                print(f"Warning: Failed to process masks output: {e}")
                traceback.print_exc()
                masks_data = None
        
        for idx in nms_indices:
            bbox = [float(x1[idx]), float(y1[idx]), float(x2[idx] - x1[idx]), float(y2[idx] - y1[idx])]
            # Validate bbox
            if bbox[2] > 0 and bbox[3] > 0:  # width and height must be positive
                pred = {
                    'bbox': bbox,
                    'confidence': float(final_confidences[idx]),  # 0-1 range
                    'class_id': int(class_ids[idx])
                }
                
                # Extract segmentation mask if available
                # idx is the index in the filtered boxes (after confidence threshold and NMS)
                # We need to map it back to the original detection index to get the correct mask
                if masks_data is not None or prototype_masks is not None:
                    try:
                        mask = None
                        
                        # Handle prototype masks (YOLO segmentation)
                        if prototype_masks is not None:
                            # We have prototype masks but need mask coefficients to combine them
                            # Check if we have mask coefficients from detection output
                            if mask_coeffs is not None and idx < len(original_indices):
                                original_idx = int(original_indices[idx])
                                if original_idx < len(mask_coeffs):
                                    # Combine prototype masks using mask coefficients
                                    coeffs = mask_coeffs[original_idx]  # [32]
                                    # Combine: mask = sum(prototype_masks[i] * coeffs[i])
                                    mask = np.zeros((prototype_masks.shape[1], prototype_masks.shape[2]), dtype=np.float32)
                                    for i in range(len(coeffs)):
                                        mask += prototype_masks[i] * coeffs[i]
                                    print(f"Combined prototype masks using coefficients for detection {idx}")
                                else:
                                    print(f"Warning: Original index {original_idx} >= len(mask_coeffs)={len(mask_coeffs)}")
                            else:
                                # No mask coefficients available - create a bbox-aligned mask
                                # Since we can't properly combine prototypes without coefficients,
                                # we'll create a mask that fits the detection box with rounded corners
                                print(f"Warning: No mask coefficients available. Creating bbox-aligned mask for detection {idx}")
                                if len(prototype_masks) > 0:
                                    # Get detection box in original image space (already scaled)
                                    box_x1_orig = int(x1[idx])
                                    box_y1_orig = int(y1[idx])
                                    box_x2_orig = int(x2[idx])
                                    box_y2_orig = int(y2[idx])
                                    
                                    # Clip to original image bounds
                                    box_x1_orig = max(0, box_x1_orig)
                                    box_y1_orig = max(0, box_y1_orig)
                                    box_x2_orig = min(original_shape[1], box_x2_orig)
                                    box_y2_orig = min(original_shape[0], box_y2_orig)
                                    
                                    if box_x2_orig > box_x1_orig and box_y2_orig > box_y1_orig:
                                        box_width = box_x2_orig - box_x1_orig
                                        box_height = box_y2_orig - box_y1_orig
                                        
                                        # Create a mask with rounded rectangle that fits the bbox
                                        # This is more accurate than using a generic prototype mask
                                        mask = np.zeros((original_shape[0], original_shape[1]), dtype=np.float32)
                                        
                                        # Create a rounded rectangle mask in the box region
                                        # Use a small radius for rounded corners (about 5% of smaller dimension)
                                        radius = min(box_width, box_height) * 0.05
                                        
                                        # Create mask for the box region with rounded corners
                                        box_mask = np.ones((box_height, box_width), dtype=np.float32)
                                        
                                        # Apply rounded corners by creating an ellipse-like shape
                                        # For simplicity, we'll use a filled rectangle, but you could add rounded corners
                                        # For now, just use the full box as mask
                                        mask[box_y1_orig:box_y2_orig, box_x1_orig:box_x2_orig] = box_mask
                                        
                                        print(f"Created bbox-aligned mask at [{box_x1_orig}, {box_y1_orig}, {box_x2_orig}, {box_y2_orig}] in original space (box size: {box_width}x{box_height})")
                                    else:
                                        # Invalid box, create empty mask
                                        mask = np.zeros((original_shape[0], original_shape[1]), dtype=np.float32)
                                        print(f"Warning: Invalid box coordinates, using empty mask")
                                    
                                    print(f"Created bbox-aligned mask, final mask shape: {mask.shape} (already in original image space)")
                        
                        # Handle direct per-detection masks
                        elif masks_data is not None:
                            # Map idx (NMS-filtered index) back to original detection index
                            if idx < len(original_indices):
                                original_idx = int(original_indices[idx])
                                print(f"Detection idx={idx} (NMS index) -> original_idx={original_idx}, masks_data shape: {masks_data.shape}")
                                
                                # Check if masks_data has the right shape
                                if len(masks_data.shape) == 3:
                                    # Shape: [num_detections, mask_height, mask_width]
                                    if original_idx < masks_data.shape[0]:
                                        mask = masks_data[original_idx].copy()  # [mask_height, mask_width]
                                        print(f"Extracted mask shape: {mask.shape}, dtype: {mask.dtype}, min/max: {np.min(mask):.4f}, {np.max(mask):.4f}")
                                    else:
                                        print(f"Warning: Original index {original_idx} >= masks_data.shape[0]={masks_data.shape[0]}")
                                        mask = None
                                elif len(masks_data.shape) == 2:
                                    # Single mask: [mask_height, mask_width] - use for all detections
                                    mask = masks_data.copy()
                                    print(f"Using single mask for all detections, shape: {mask.shape}")
                                else:
                                    print(f"Warning: Unexpected masks_data shape: {masks_data.shape}")
                                    mask = None
                            else:
                                print(f"Warning: NMS index {idx} >= len(original_indices)={len(original_indices)}")
                                mask = None
                        
                        if mask is not None:
                            
                            # Mask values are typically in [0, 1] range or logits
                            # Apply sigmoid if needed
                            if np.any(mask < 0) or np.any(mask > 1.5):
                                mask = 1.0 / (1.0 + np.exp(-mask))  # Sigmoid
                            
                            # Check if mask is already in original image space (from prototype fallback)
                            # or in model input space (from per-detection masks)
                            mask_height, mask_width = mask.shape
                            
                            if mask_height == original_shape[0] and mask_width == original_shape[1]:
                                # Mask is already in original image space (from prototype fallback)
                                mask_resized = mask
                                print(f"Mask already in original image space: {mask_resized.shape}")
                            else:
                                # Mask is in model input space (640x640), need to scale to original image
                                mask_model_size = mask  # At 640x640 or smaller
                                
                                # Scale from model input space to original image space
                                # Account for the resized image area (not padding)
                                if resized_size:
                                    resized_width, resized_height = resized_size
                                    # Crop mask to resized area (exclude padding)
                                    mask_resized_cropped = mask_model_size[:resized_height, :resized_width]
                                    
                                    # Scale to original image size
                                    mask_resized = cv2.resize(mask_resized_cropped, (original_shape[1], original_shape[0]), interpolation=cv2.INTER_LINEAR)
                                else:
                                    # No resizing info, just scale directly
                                    mask_resized = cv2.resize(mask_model_size, (original_shape[1], original_shape[0]), interpolation=cv2.INTER_LINEAR)
                            
                            # Convert mask to polygon (contour)
                            print(f"Mask resized shape: {mask_resized.shape}, min/max: {np.min(mask_resized):.4f}, {np.max(mask_resized):.4f}")
                            
                            # Use adaptive threshold - if max value is low, use a lower threshold
                            mask_max = np.max(mask_resized)
                            mask_min = np.min(mask_resized)
                            if mask_max < 0.3:
                                # Very low values, might need sigmoid or different threshold
                                threshold = 0.1
                                print(f"Warning: Mask has low max value ({mask_max:.4f}), using lower threshold {threshold}")
                            else:
                                threshold = 0.5
                            
                            mask_binary = (mask_resized > threshold).astype(np.uint8) * 255
                            num_positive_pixels = np.sum(mask_binary > 0)
                            print(f"Mask binary: {num_positive_pixels} pixels above threshold {threshold} (out of {mask_binary.size} total)")
                            
                            contours, _ = cv2.findContours(
                                mask_binary,
                                cv2.RETR_EXTERNAL,
                                cv2.CHAIN_APPROX_SIMPLE
                            )
                            print(f"Found {len(contours)} contours")
                            if len(contours) > 0:
                                # Get the largest contour
                                largest_contour = max(contours, key=cv2.contourArea)
                                contour_area = cv2.contourArea(largest_contour)
                                print(f"Largest contour area: {contour_area}")
                                
                                if contour_area > 10:  # Only use contours with meaningful area
                                    # Simplify contour to reduce points (but keep enough detail)
                                    epsilon = 0.001 * cv2.arcLength(largest_contour, True)
                                    approx = cv2.approxPolyDP(largest_contour, epsilon, True)
                                    # Flatten to [x1, y1, x2, y2, ...] format
                                    if len(approx) >= 3:  # Need at least 3 points for a polygon
                                        polygon = approx.reshape(-1, 2).flatten().tolist()
                                        pred['segmentation'] = [polygon]
                                        # original_idx might not be defined for prototype masks
                                        original_idx_str = f"original_idx={original_idx}" if 'original_idx' in locals() else "prototype_mask"
                                        print(f"Successfully extracted segmentation mask with {len(approx)} points for detection {idx} ({original_idx_str})")
                                    else:
                                        print(f"Warning: Contour has only {len(approx)} points, need at least 3")
                                else:
                                    print(f"Warning: Contour area {contour_area} too small, skipping")
                            else:
                                print(f"Warning: No contours found in mask for detection {idx}")
                        else:
                            print(f"Warning: Could not extract mask for detection {idx} - mask is None")
                    except Exception as e:
                        # If mask extraction fails, just skip it and use bbox only
                        import traceback
                        print(f"Warning: Failed to extract mask for prediction {idx}: {e}")
                        traceback.print_exc()
                
                predictions.append(pred)
            else:
                print(f"Warning: Skipping invalid bbox: {bbox}")
    else:
        print("Warning: NMS returned no indices")
    
    return predictions

def draw_predictions(img, predictions, class_names):
    '''Draw bounding boxes on image'''
    img_annotated = img.copy()
    
    for pred in predictions:
        x, y, w, h = pred['bbox']
        x, y, w, h = int(x), int(y), int(w), int(h)
        
        class_id = pred.get('class_id', 0)
        class_name = class_names[class_id] if class_id < len(class_names) else f'Class {class_id}'
        confidence = pred['confidence']
        
        # Draw bounding box
        color = (0, 255, 0)
        cv2.rectangle(img_annotated, (x, y), (x + w, y + h), color, 2)
        
        # Draw label (confidence is already 0-1, format as percentage)
        label = f'{class_name}: {confidence * 100:.1f}%'
        (label_width, label_height), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(img_annotated, (x, y - label_height - 10), (x + label_width, y), color, -1)
        cv2.putText(img_annotated, label, (x, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    
    return img_annotated

# Main inference
onnx_path = sys.argv[1]
image_path = sys.argv[2]
output_json = sys.argv[3]
output_image = sys.argv[4]
class_names_json = sys.argv[5] if len(sys.argv) > 5 else '[]'

class_names = json.loads(class_names_json)

# Load ONNX model
session = ort.InferenceSession(onnx_path)

# Get input shape (ONNX may return dynamic dims as strings; coerce to int for preprocess)
input_name = session.get_inputs()[0].name
input_shape = session.get_inputs()[0].shape
def _dim(d):
    try:
        return int(d) if d is not None else 640
    except (TypeError, ValueError):
        return 640
if len(input_shape) == 4:
    target_size = (_dim(input_shape[3]), _dim(input_shape[2]))
else:
    target_size = (640, 640)

# Preprocess image
img_input, original_shape, scale, original_img, resized_size = preprocess_image(image_path, target_size)

# Run inference
outputs = session.run(None, {input_name: img_input})
output = outputs[0]

# Check if there's a second output (masks for segmentation models)
has_masks = len(outputs) > 1
masks_output = outputs[1] if has_masks else None

print(f"Number of outputs: {len(outputs)}")
print(f"Has masks: {has_masks}")
if has_masks:
    print(f"Masks output shape: {masks_output.shape}")
    print(f"Masks output dtype: {masks_output.dtype}")
    print(f"Masks output sample values (min/max/mean): {np.min(masks_output):.4f}, {np.max(masks_output):.4f}, {np.mean(masks_output):.4f}")
else:
    print("WARNING: No mask output detected! This might be a detection-only model, or the ONNX export didn't include masks.")

# Debug: Print output shape and sample values
print(f"Output shape: {output.shape}")
if len(output.shape) >= 2:
    print(f"Sample output (first 5 rows, first 10 features):")
    sample = output[:5, :10] if output.shape[0] >= 5 else output[:, :10]
    print(sample)

# Postprocess (pass class_names to limit class scores to actual classes)
predictions = postprocess_yolo_output(output, original_shape, scale, class_names=class_names, resized_size=resized_size, masks_output=masks_output)

print(f"Postprocessed predictions count: {len(predictions)}")
print(f"Available class names ({len(class_names)}): {class_names}")
if len(predictions) > 0:
    print(f"First prediction before class mapping: {predictions[0]}")

# Add class names and debug segmentation
for pred in predictions:
    class_id = pred.get('class_id', 0)
    print(f"Mapping class_id={class_id} (class_names length={len(class_names)})")
    
    if class_id < len(class_names) and len(class_names) > 0:
        pred['class'] = class_names[class_id]
        print(f"  -> Mapped to: {pred['class']}")
    else:
        # Class ID out of bounds - this shouldn't happen if model is correct
        pred['class'] = f'Class {class_id}'
        print(f"  -> WARNING: class_id {class_id} out of bounds! Using fallback name: {pred['class']}")
        if len(class_names) > 0:
            print(f"  -> Available class IDs: 0 to {len(class_names) - 1}")
    
    # Debug segmentation
    if 'segmentation' in pred:
        seg = pred['segmentation']
        if seg and len(seg) > 0 and seg[0]:
            print(f"  -> Has segmentation: {len(seg[0])} points in polygon")
        else:
            print(f"  -> WARNING: segmentation exists but is empty or invalid")
    else:
        print(f"  -> No segmentation mask for this prediction")
    
    print(f"Final prediction: class_id={class_id}, class={pred['class']}, confidence={pred.get('confidence', 0)}, has_segmentation={('segmentation' in pred and pred['segmentation'])}")

# Draw annotations
annotated_img = draw_predictions(original_img, predictions, class_names)
cv2.imwrite(output_image, annotated_img)

# Save results
results = {
    'predictions': predictions,
    'num_predictions': len(predictions)
}

with open(output_json, 'w') as f:
    json.dump(results, f, indent=2)

print(f"Found {len(predictions)} predictions")
"""
            
            with open(script_path, 'w') as f:
                f.write(inference_script)
            
            # Run inference script
            # Try to use the same Python interpreter that's running this script
            import sys
            python_executable = sys.executable
            
            class_names_json = json.dumps(class_names)
            cmd = [
                python_executable,
                str(script_path),
                str(onnx_path),
                tmp_image_path,
                str(result_json_path),
                str(annotated_image_path),
                class_names_json
            ]
            
            logger.info(f"Running inference with command: {' '.join(cmd)}")
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                env=os.environ.copy()  # Use the same environment
            )
            
            # Log the subprocess output for debugging
            if result.stdout:
                logger.info(f"Inference script stdout:\n{result.stdout}")
            if result.stderr:
                logger.warning(f"Inference script stderr:\n{result.stderr}")
            
            if result.returncode != 0:
                error_msg = result.stderr or result.stdout or "Unknown error"
                logger.error(f"Inference script error: {error_msg}")
                raise Exception(f"Inference failed: {error_msg}")
            
            # Read results
            with open(result_json_path, 'r') as f:
                inference_results = json.load(f)
            
            # Copy annotated image to static directory for serving
            static_dir = Path("static/inference_results")
            static_dir.mkdir(parents=True, exist_ok=True)
            annotated_filename = f"annotated_{task_id}_{uuid.uuid4().hex[:8]}.jpg"
            annotated_static_path = static_dir / annotated_filename
            shutil.copy2(str(annotated_image_path), str(annotated_static_path))
            
            # Cleanup temporary files
            os.unlink(tmp_image_path)
            shutil.rmtree(output_dir, ignore_errors=True)
            
            # Cleanup extracted ONNX file if it was extracted from zip
            if extracted_onnx_path and extracted_onnx_path.exists():
                try:
                    # Also remove the parent temp directory if it's empty
                    temp_parent = extracted_onnx_path.parent
                    extracted_onnx_path.unlink()
                    if temp_parent.exists() and not any(temp_parent.iterdir()):
                        temp_parent.rmdir()
                    logger.info(f"Cleaned up extracted ONNX file: {extracted_onnx_path}")
                except Exception as e:
                    logger.warning(f"Failed to cleanup extracted ONNX file: {e}")
            
            return JSONResponse({
                "success": True,
                "result": {
                    "predictions": inference_results.get('predictions', []),
                    "image_url": f"/static/inference_results/{annotated_filename}"
                }
            })
            
        except Exception as e:
            # Cleanup on error
            if os.path.exists(tmp_image_path):
                os.unlink(tmp_image_path)
            logger.error(f"Error running inference: {str(e)}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in test inference: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")
