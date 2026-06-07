"""
Celery tasks for model export.
"""
import os
import logging
import shutil
import json
import zipfile
from pathlib import Path
from datetime import datetime
from typing import Dict, Any

from celery import Task
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.gpu_app import celery_app
from app.models import Task as TaskModel
from app.tasks.training_common import get_ultralytics_yolo

logger = logging.getLogger(__name__)

# Directory where pre-downloaded Ultralytics models are stored (populated at Docker build)
PRETRAINED_MODELS_DIR = Path("/app/models")

def _pretrained_model_path(model_name: str) -> Path | None:
    """Resolve foundation model name to path under PRETRAINED_MODELS_DIR if it exists."""
    name = model_name.strip().lower().replace(".pt", "")
    for candidate in [f"{name}.pt", f"{model_name}.pt"]:
        path = PRETRAINED_MODELS_DIR / candidate
        if path.exists():
            return path
    return None

# COCO 80 class names for foundation (pre-trained) model exports
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
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]

# Database setup for Celery workers
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db/lai_db')
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _create_inference_script(class_names: list) -> str:
    """Create a standalone Python inference script for ONNX models"""
    class_names_json = json.dumps(class_names)
    
    script = f"""import onnxruntime as ort
import numpy as np
import cv2
import json
import sys
import os

def preprocess_image(image_path, target_size=(640, 640)):
    '''Preprocess image for YOLO ONNX model'''
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image from {{image_path}}")
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
    
    # Pad to target size
    img_padded = np.zeros((target_size[1], target_size[0], 3), dtype=np.uint8)
    img_padded[:new_height, :new_width] = img_resized
    
    # Normalize to [0, 1] and convert to float32
    img_normalized = img_padded.astype(np.float32) / 255.0
    
    # Convert to NCHW format
    img_input = np.transpose(img_normalized, (2, 0, 1))
    img_input = np.expand_dims(img_input, axis=0)
    
    return img_input, original_shape, scale, img, (new_width, new_height)

def postprocess_yolo_output(output, original_shape, scale, conf_threshold=0.25, iou_threshold=0.45, class_names=None, resized_size=None, masks_output=None):
    '''Postprocess YOLO ONNX output to get bounding boxes and masks'''
    predictions = []
    
    # Remove batch dimension if present
    if len(output.shape) == 3:
        output = output[0]
    
    # Check if output is transposed
    if len(output.shape) == 2 and output.shape[0] < output.shape[1] and output.shape[0] <= 100:
        output = output.T
    
    num_detections = output.shape[0]
    num_features = output.shape[1]
    
    if num_features < 4 or num_detections == 0:
        return predictions
    
    # Extract boxes (first 4 values)
    boxes = output[:, :4]
    # Ultralytics YOLOv8/v11/v26: [bbox(4), class_scores(N)] - no objectness, confidence = max(class_scores)
    # Legacy: [bbox(4), objectness(1), class_scores(N)]
    num_expected = len(class_names) if class_names else None
    has_objectness = True
    if num_expected is not None:
        if num_features == 4 + num_expected:
            has_objectness = False
        # else 5 + num_expected -> has_objectness stays True
    num_classes = (num_features - 4) if not has_objectness else (num_features - 5)
    if not has_objectness:
        class_scores = output[:, 4:4 + num_classes]
        raw_confidence = np.max(class_scores, axis=1)
    else:
        class_scores = output[:, 5:5 + num_classes]
        raw_confidence = output[:, 4]
    
    # Apply softmax if needed
    if np.any(class_scores < 0) or np.any(class_scores > 1.5):
        exp_scores = np.exp(class_scores - np.max(class_scores, axis=1, keepdims=True))
        class_scores = exp_scores / np.sum(exp_scores, axis=1, keepdims=True)
    
    if class_scores.shape[1] > len(class_names) and class_names:
        class_scores = class_scores[:, :len(class_names)]
    
    class_ids = np.argmax(class_scores, axis=1)
    class_confidences = np.max(class_scores, axis=1)
    if not has_objectness:
        final_confidences = np.clip(class_confidences, 0.0, 1.0)
    else:
        if np.any(raw_confidence < 0) or np.any(raw_confidence > 1.5):
            final_confidences = 1.0 / (1.0 + np.exp(-raw_confidence))
        else:
            final_confidences = raw_confidence.copy()
        final_confidences = np.clip(final_confidences, 0.0, 1.0)
    
    # Filter by confidence
    valid_indices = final_confidences > conf_threshold
    if not np.any(valid_indices):
        return predictions
    
    boxes = boxes[valid_indices]
    final_confidences = final_confidences[valid_indices]
    class_ids = class_ids[valid_indices]
    
    # Convert coordinates: Ultralytics may output xyxy (x1,y1,x2,y2) or xywh (center, center, w, h)
    is_normalized = np.max(boxes) <= 1.0 and np.min(boxes) >= 0.0
    model_input_size = 640
    use_xyxy = False
    if not has_objectness and len(boxes) > 0:
        xyxy_like = np.mean((boxes[:, 2] > boxes[:, 0]) & (boxes[:, 3] > boxes[:, 1]))
        if xyxy_like > 0.5:
            use_xyxy = True
    if use_xyxy:
        x1_norm, y1_norm = boxes[:, 0], boxes[:, 1]
        x2_norm, y2_norm = boxes[:, 2], boxes[:, 3]
        if is_normalized:
            x1_model = x1_norm * model_input_size
            y1_model = y1_norm * model_input_size
            x2_model = x2_norm * model_input_size
            y2_model = y2_norm * model_input_size
        else:
            x1_model, y1_model = x1_norm, y1_norm
            x2_model, y2_model = x2_norm, y2_norm
    else:
        if is_normalized:
            x_center = boxes[:, 0] * model_input_size
            y_center = boxes[:, 1] * model_input_size
            width = boxes[:, 2] * model_input_size
            height = boxes[:, 3] * model_input_size
        else:
            x_center, y_center = boxes[:, 0], boxes[:, 1]
            width, height = boxes[:, 2], boxes[:, 3]
        x1_model = x_center - width / 2
        y1_model = y_center - height / 2
        x2_model = x_center + width / 2
        y2_model = y_center + height / 2
    
    # Scale to original image
    if resized_size:
        resized_width, resized_height = resized_size
        x1_model = np.clip(x1_model, 0, resized_width)
        y1_model = np.clip(y1_model, 0, resized_height)
        x2_model = np.clip(x2_model, 0, resized_width)
        y2_model = np.clip(y2_model, 0, resized_height)
    
    x1 = x1_model / scale
    y1 = y1_model / scale
    x2 = x2_model / scale
    y2 = y2_model / scale
    
    x1 = np.clip(x1, 0, original_shape[1])
    y1 = np.clip(y1, 0, original_shape[0])
    x2 = np.clip(x2, 0, original_shape[1])
    y2 = np.clip(y2, 0, original_shape[0])
    
    # Apply NMS
    boxes_for_nms = np.column_stack([x1, y1, x2 - x1, y2 - y1])
    indices = cv2.dnn.NMSBoxes(
        boxes_for_nms.tolist(),
        final_confidences.tolist(),
        conf_threshold,
        iou_threshold
    )
    
    if len(indices) > 0:
        nms_indices = indices.flatten()
        for idx in nms_indices:
            bbox = [float(x1[idx]), float(y1[idx]), float(x2[idx] - x1[idx]), float(y2[idx] - y1[idx])]
            if bbox[2] > 0 and bbox[3] > 0:
                pred = {{
                    'bbox': bbox,
                    'confidence': float(final_confidences[idx]),
                    'class_id': int(class_ids[idx])
                }}
                if class_names and class_ids[idx] < len(class_names):
                    pred['class'] = class_names[class_ids[idx]]
                predictions.append(pred)
    
    return predictions

# Main execution
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python run_inference.py <onnx_model_path> <image_path>")
        sys.exit(1)
    
    onnx_path = sys.argv[1]
    image_path = sys.argv[2]
    
    # Load class names
    class_names = {class_names_json}
    
    # Load ONNX model
    session = ort.InferenceSession(onnx_path)
    
    # Get input shape (ONNX may return dynamic dims as strings; coerce to int)
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
    outputs = session.run(None, {{input_name: img_input}})
    output = outputs[0]
    masks_output = outputs[1] if len(outputs) > 1 else None
    
    # Postprocess
    predictions = postprocess_yolo_output(output, original_shape, scale, class_names=class_names, resized_size=resized_size, masks_output=masks_output)
    
    # Print results
    print(f"Found {{len(predictions)}} predictions")
    for pred in predictions:
        class_name = pred.get('class', f"Class {{pred['class_id']}}")
        conf = pred['confidence'] * 100
        bbox = pred['bbox']
        print(f"  {{class_name}}: {{conf:.1f}}% - BBox: [{{bbox[0]:.1f}}, {{bbox[1]:.1f}}, {{bbox[2]:.1f}}, {{bbox[3]:.1f}}]")
"""
    return script


def _create_readme(model_filename: str, class_names: list) -> str:
    """Create a README file for the exported model"""
    class_list = "\\n".join([f"  - {name}" for name in class_names]) if class_names else "  (No classes defined)"
    
    readme = f"""# ONNX Model Export

This package contains an exported YOLO model in ONNX format along with the necessary files to run inference.

## Files

- `{model_filename}` - The ONNX model file
- `classes.json` - Class names and metadata
- `run_inference.py` - Standalone Python script for running inference

## Usage

### Prerequisites

Install required Python packages:

```bash
pip install onnxruntime opencv-python numpy
```

### Running Inference

```bash
python run_inference.py <model_path> <image_path>
```

Example:

```bash
python run_inference.py {model_filename} test_image.jpg
```

## Model Information

- **Format**: ONNX
- **Input Size**: 640x640 (with aspect ratio preserving resize and padding)
- **Number of Classes**: {len(class_names) if class_names else 'Unknown'}

### Class Names

{class_list}

## Notes

- The model expects RGB images
- Images are automatically resized to 640x640 while maintaining aspect ratio
- Padding is added to maintain the input size
- Confidence threshold: 0.25 (default)
- IoU threshold: 0.45 (default)

## Output Format

The inference script outputs predictions in the following format:

```json
{{
  "bbox": [x, y, width, height],
  "confidence": 0.0-1.0,
  "class_id": 0,
  "class": "class_name"
}}
```

Coordinates are in pixel space relative to the original image dimensions.
"""
    return readme


class ExportTask(Task):
    """Base task for export with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails"""
        logger.error(f"Export task {task_id} failed: {exc}")
        
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


@celery_app.task(base=ExportTask, bind=True, name='app.tasks.export_tasks.export_yolo_model')
def export_yolo_model(self, task_id: int, export_config: Dict[str, Any]):
    """
    Celery task to convert YOLO model to ONNX format.
    This task is executed by Celery worker with proper queuing.
    """
    logger.info(f"Starting YOLO export task {task_id} (Celery task {self.request.id})")
    db = SessionLocal()
    
    try:
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            logger.error(f"Export task {task_id} not found")
            return
        
        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 10
        task.task_metadata = {
            **task.task_metadata,
            "stage": "starting",
            "celery_task_id": self.request.id
        }
        db.commit()
        
        model_path = export_config.get('model_path')
        model_name = export_config.get('model_name')
        export_format = export_config.get('export_format', 'onnx')
        training_task_id = export_config.get('training_task_id')
        
        # Get class names: from training task for trained models, COCO for foundation
        class_names = []
        if training_task_id:
            training_task = db.query(TaskModel).filter(TaskModel.id == training_task_id).first()
            if training_task and training_task.task_metadata:
                class_names = training_task.task_metadata.get('class_names', [])
        if not class_names and model_name:
            class_names = COCO_CLASSES
        
        # Persist exports on a mounted volume when an output_dir is provided.
        configured_output_dir = export_config.get("output_dir")
        output_dir = Path(configured_output_dir) if configured_output_dir else Path("static/exports")
        output_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Starting export (model_path={model_path}, model_name={model_name}) to {export_format}")
        logger.info(f"Class names to save: {len(class_names)}")
        
        # Load YOLO model (by path for trained, by name for foundation)
        YOLO = get_ultralytics_yolo()
        task.progress = 20
        task.task_metadata = {**task.task_metadata, "stage": "loading_model"}
        db.commit()
        
        if model_name:
            # Use pre-downloaded model from /app/models if present (from Docker build)
            pretrained_path = _pretrained_model_path(model_name)
            if pretrained_path is not None:
                logger.info(f"Loading foundation model from pre-downloaded path: {pretrained_path}")
                model = YOLO(str(pretrained_path))
            else:
                model = YOLO(model_name)
            # Exporter uses model.pt_path (or yaml_file) to build output paths; set it if missing (e.g. hub-loaded model)
            if not getattr(model, 'pt_path', None):
                model_path_attr = getattr(model, 'path', None) or getattr(model, 'ckpt_path', None)
                if model_path_attr:
                    model.pt_path = Path(model_path_attr) if not isinstance(model_path_attr, Path) else model_path_attr
        else:
            model = YOLO(model_path)
        
        # Export to ONNX
        task.progress = 50
        task.task_metadata = {**task.task_metadata, "stage": "exporting"}
        db.commit()
        
        export_kwargs = {
            'format': 'onnx',
            'imgsz': export_config.get('imgsz', 640),
            'half': export_config.get('half', False),
            'simplify': export_config.get('simplify', False),
            'dynamic': export_config.get('dynamic', False),
        }
        if export_config.get('opset') is not None:
            export_kwargs['opset'] = export_config['opset']
        # workspace: Ultralytics expects int or float only (e.g. MB). Never pass a path or string.
        _w = export_config.get("workspace")
        if isinstance(_w, (int, float)):
            export_kwargs["workspace"] = _w
        logger.info(f"Exporting ONNX with parameters: {export_kwargs}")
        
        if export_format.lower() == 'onnx':
            if model_name:
                checkpoint = "foundation"
                model_stem = model_name.replace(".pt", "").strip()
                exported_file_str = model.export(**export_kwargs)
                # export() can return str or list of paths (e.g. when half=True)
                if isinstance(exported_file_str, (list, tuple)):
                    exported_file_str = next((p for p in exported_file_str if str(p).endswith('.onnx')), exported_file_str[0] if exported_file_str else None)
                exported_file = Path(exported_file_str) if exported_file_str else None
                if not exported_file or not exported_file.exists():
                    # Fallback: look in workspace (output_dir) for expected name
                    half_suffix = "_fp16" if export_config.get('half', False) else ""
                    for candidate in [output_dir / f"{model_stem}{half_suffix}.onnx", output_dir / f"{model_stem}.onnx"]:
                        if candidate.exists():
                            exported_file = candidate
                            break
                    if not exported_file or not exported_file.exists():
                        # Last resort: any .onnx in output_dir from this export
                        for p in output_dir.glob("*.onnx"):
                            if model_stem in p.stem:
                                exported_file = p
                                break
                if not exported_file:
                    exported_file = Path(exported_file_str) if isinstance(exported_file_str, str) else Path(str(exported_file_str))
            else:
                model.export(**export_kwargs)
                checkpoint = export_config.get('checkpoint', 'best')
                model_stem = Path(model_path).stem
                model_dir = Path(model_path).parent
                exported_file = model_dir / f"{model_stem}.onnx"
                if not exported_file.exists():
                    exported_file = model_dir / f"{Path(model_path).stem.replace('.pt', '')}.onnx"
                if not exported_file.exists():
                    exported_file = Path(model_path).with_suffix('.onnx')
            
            output_filename = f"{model_stem}_{checkpoint}.onnx"
            if export_config.get('half', False):
                output_filename = output_filename.replace('.onnx', '_fp16.onnx')
            output_path = output_dir / output_filename
            
            if model_name and exported_file and exported_file.exists():
                if exported_file.resolve() != output_path.resolve():
                    shutil.copy2(str(exported_file), str(output_path))
            elif model_path and exported_file.exists():
                # Copy to the configured persistent output directory for trained models.
                shutil.copy2(str(exported_file), str(output_path))
            
            if output_path.exists():
                logger.info(f"Model exported to {output_path}")
                
                # Save class names to a JSON file alongside the ONNX file
                classes_file = None
                if class_names:
                    # Create classes file: model.onnx -> model.onnx.classes.json
                    classes_file = Path(str(output_path) + '.classes.json')
                    with open(classes_file, 'w') as f:
                        json.dump({
                            'class_names': class_names,
                            'num_classes': len(class_names),
                            'exported_at': datetime.utcnow().isoformat(),
                            'training_task_id': training_task_id
                        }, f, indent=2)
                    logger.info(f"Class names saved to {classes_file}")
                
                # Create a zip file with model, class names, and inference script
                zip_filename = output_path.stem + '.zip'
                zip_path = output_dir / zip_filename
                
                try:
                    # Read the inference script template from export router
                    # We'll create a simplified standalone version
                    inference_script = _create_inference_script(class_names)
                    
                    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                        # Add ONNX model
                        zipf.write(output_path, output_path.name)
                        logger.info(f"Added {output_path.name} to zip")
                        
                        # Add class names JSON if available
                        if classes_file and classes_file.exists():
                            zipf.write(classes_file, 'classes.json')
                            logger.info(f"Added classes.json to zip")
                        elif class_names:
                            # Create classes.json if it doesn't exist
                            classes_data = {
                                'class_names': class_names,
                                'num_classes': len(class_names),
                                'exported_at': datetime.utcnow().isoformat(),
                                'training_task_id': training_task_id
                            }
                            zipf.writestr('classes.json', json.dumps(classes_data, indent=2))
                            logger.info(f"Added classes.json to zip (created inline)")
                        
                        # Add inference script
                        zipf.writestr('run_inference.py', inference_script)
                        logger.info(f"Added run_inference.py to zip")
                        
                        # Add README
                        readme_content = _create_readme(output_path.name, class_names)
                        zipf.writestr('README.md', readme_content)
                        logger.info(f"Added README.md to zip")
                    
                    logger.info(f"Successfully created zip file: {zip_path} (size: {zip_path.stat().st_size} bytes)")
                    # Store absolute path to ensure download endpoint can find it
                    zip_path_str = str(zip_path.resolve())
                    zip_filename = zip_path.name
                except Exception as e:
                    logger.error(f"Failed to create zip file: {e}", exc_info=True)
                    # Still set zip_path_str so the code doesn't fail, but log the error
                    zip_path_str = str(zip_path.resolve())
                    zip_filename = zip_path.name
                    raise  # Re-raise to fail the task
            else:
                raise FileNotFoundError(f"Exported ONNX file not found for {model_name or model_path}")
        else:
            raise ValueError(f"Unsupported export format: {export_format}")
        
        # Ensure zip_path_str and zip_filename are defined
        if 'zip_path_str' not in locals():
            # Fallback: create zip file even if something went wrong
            zip_filename = output_path.stem + '.zip'
            zip_path = output_dir / zip_filename
            zip_path_str = str(zip_path.resolve())
            logger.warning(f"zip_path_str not defined, using fallback: {zip_path_str}")
        
        # Always expose the artifact through the API download endpoint.
        zip_relative_path = f"/export/download/{task_id}"
        task.status = "completed"
        task.completed_at = datetime.utcnow()
        task.progress = 100
        task.task_metadata = {
            **task.task_metadata,
            "stage": "completed",
            "exported_file": zip_path_str,  # Store absolute zip file path
            "exported_file_url": zip_relative_path,
            "export_format": export_format,
            "file_size": zip_path.stat().st_size if zip_path.exists() else 0,
            "onnx_file": str(output_path.resolve()),  # Keep reference to ONNX file (absolute path)
            "class_names": class_names,  # For download endpoint when building zip from ONNX
            "export_parameters": {
                "half": export_config.get('half', False),
                "imgsz": export_config.get('imgsz', 640),
                "simplify": export_config.get('simplify', False),
                "opset": export_config.get('opset'),
                "dynamic": export_config.get('dynamic', False),
                "workspace": export_config.get('workspace'),
            }
        }
        db.commit()
        
        logger.info(f"Export completed successfully for task {task_id}")
        
        return {
            "status": "completed",
            "task_id": task_id,
            "exported_file": zip_path_str,
            "zip_file": zip_path_str
        }
        
    except Exception as e:
        logger.error(f"Error in export task {task_id}: {str(e)}", exc_info=True)
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if task:
            task.status = "failed"
            task.completed_at = datetime.utcnow()
            task.error_message = str(e)
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "failed",
                "error": str(e),
                "error_details": {
                    "type": type(e).__name__,
                    "message": str(e),
                    "traceback": None  # Could add traceback if needed
                }
            }
            db.commit()
        raise
        
    finally:
        if db:
            db.close()
