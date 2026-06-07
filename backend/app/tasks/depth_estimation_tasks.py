"""
Celery tasks for depth estimation using Depth-Anything-V2 ONNX models.
"""
import os
import logging
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import numpy as np
import cv2
from PIL import Image as PILImage

from celery import Task
from app.celery.general_app import celery_app
from ..database import SessionLocal
from .. import models

logger = logging.getLogger(__name__)

# Model directory from Docker pre-download (or runtime download if install used LAI_DEPTH_MODELS=none)
DEPTH_MODELS_DIR = Path("/app/ai_models/depth_estimation")
_DEPTH_ONNX_BASE_URL = (
    "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0"
)


def _ensure_depth_onnx(model_path: Path, model_filename: str, task_id: int) -> None:
    """Download ONNX once if missing (e.g. image built with LAI_DEPTH_MODELS=none)."""
    if model_path.exists():
        return
    DEPTH_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    url = f"{_DEPTH_ONNX_BASE_URL}/{model_filename}"
    logger.info(f"Task {task_id}: Downloading depth ONNX (on demand): {url}")
    urllib.request.urlretrieve(url, model_path)
    logger.info(f"Task {task_id}: Saved to {model_path}")


class DepthEstimationTask(Task):
    """Base task for depth estimation with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Handle task failure"""
        logger.error(f"Depth estimation task {task_id} failed: {exc}")
        db = SessionLocal()
        try:
            if args and len(args) > 0:
                db_task_id = args[0]
                task = db.query(models.Task).filter(models.Task.id == db_task_id).first()
                if task:
                    task.status = 'failed'
                    task.error_message = str(exc)
                    task.completed_at = datetime.utcnow()
                    db.commit()
        finally:
            db.close()


def load_depth_model(model_size: str, environment: str, task_id: int):
    """Load Depth-Anything-V2 ONNX model.
    
    Args:
        model_size: 'vits', 'vitb', or 'vitl'
        environment: 'indoor' or 'outdoor'
        task_id: Task ID for logging
        
    Returns:
        onnxruntime.InferenceSession
    """
    try:
        import onnxruntime as ort
    except ImportError:
        raise ImportError("onnxruntime is required for depth estimation. Install with: pip install onnxruntime")
    
    model_filename = f"depth_anything_v2_{model_size}_{environment}_dynamic.onnx"
    model_path = DEPTH_MODELS_DIR / model_filename

    try:
        _ensure_depth_onnx(model_path, model_filename, task_id)
    except Exception as e:
        raise RuntimeError(
            f"Depth ONNX not at {model_path} and on-demand download failed: {e}"
        ) from e
    if not model_path.exists():
        raise FileNotFoundError(f"Depth model not found at {model_path} after download attempt.")
    
    logger.info(f"Task {task_id}: Loading depth model from {model_path}")
    
    # Create ONNX Runtime session
    session = ort.InferenceSession(
        str(model_path),
        providers=['CPUExecutionProvider']  # Use CPU for now, can add CUDA later
    )
    
    logger.info(f"Task {task_id}: Depth model loaded successfully")
    return session


def preprocess_image_for_depth(image_path: Path, target_size: tuple = (518, 518)) -> np.ndarray:
    """Preprocess image for depth estimation.
    
    Args:
        image_path: Path to input image
        target_size: Target size (height, width) for the model
        
    Returns:
        Preprocessed image array (1, 3, H, W) in BGR format
    """
    # Read image
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Failed to load image: {image_path}")
    
    # Resize to target size
    img_resized = cv2.resize(img, (target_size[1], target_size[0]), interpolation=cv2.INTER_LINEAR)
    
    # Convert to float and normalize to [0, 1]
    img_normalized = img_resized.astype(np.float32) / 255.0
    
    # Transpose to (C, H, W) and add batch dimension
    img_transposed = np.transpose(img_normalized, (2, 0, 1))  # HWC -> CHW
    img_batch = np.expand_dims(img_transposed, axis=0)  # Add batch dimension
    
    return img_batch


def postprocess_depth_map(depth_output: np.ndarray, original_size: tuple) -> np.ndarray:
    """Postprocess depth map to original image size and convert to colormap.
    
    Args:
        depth_output: Raw depth output from model
        original_size: Original image size (height, width)
        
    Returns:
        Depth map as RGB image (uint8)
    """
    # Remove batch dimension if present
    if depth_output.ndim == 4:
        depth_output = depth_output[0, 0]
    elif depth_output.ndim == 3:
        depth_output = depth_output[0]
    
    # Normalize to [0, 255]
    depth_min = depth_output.min()
    depth_max = depth_output.max()
    
    if depth_max - depth_min > 0:
        depth_normalized = ((depth_output - depth_min) / (depth_max - depth_min) * 255).astype(np.uint8)
    else:
        depth_normalized = np.zeros_like(depth_output, dtype=np.uint8)
    
    # Resize to original size
    depth_resized = cv2.resize(depth_normalized, (original_size[1], original_size[0]), interpolation=cv2.INTER_LINEAR)
    
    # Apply colormap for better visualization
    depth_colored = cv2.applyColorMap(depth_resized, cv2.COLORMAP_INFERNO)
    
    return depth_colored


def process_single_image_depth(
    session,
    image_path: Path,
    output_path: Path,
    task_id: int
) -> tuple[int, int]:
    """Process a single image for depth estimation.
    
    Args:
        session: ONNX Runtime session
        image_path: Path to input image
        output_path: Path to save depth map
        task_id: Task ID for logging
        
    Returns:
        Tuple of (width, height) of output image
    """
    try:
        # Get original image size
        img = cv2.imread(str(image_path))
        if img is None:
            logger.warning(f"Task {task_id}: Failed to load image {image_path}")
            return 0, 0
        
        original_size = (img.shape[0], img.shape[1])  # height, width
        
        # Preprocess
        input_tensor = preprocess_image_for_depth(image_path)
        
        # Run inference
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        depth_output = session.run([output_name], {input_name: input_tensor})[0]
        
        # Postprocess
        depth_colored = postprocess_depth_map(depth_output, original_size)
        
        # Save depth map
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(output_path), depth_colored)
        
        return depth_colored.shape[1], depth_colored.shape[0]  # width, height
        
    except Exception as e:
        logger.error(f"Task {task_id}: Error processing image {image_path}: {e}")
        return 0, 0


@celery_app.task(base=DepthEstimationTask, bind=True, name='app.tasks.depth_estimation_tasks.generate_depth_maps')
def generate_depth_maps(
    self,
    task_id: int,
    dataset_id: int,
    model_size: str,
    environment: str,
    save_as: str = "collection",
    new_dataset_name: Optional[str] = None
):
    """
    Generate depth maps for all images in a dataset.
    
    Args:
        task_id: Database task ID
        dataset_id: Source dataset ID
        model_size: Model size ('vits', 'vitb', 'vitl')
        environment: Environment type ('indoor', 'outdoor')
        save_as: 'collection' or 'dataset'
        new_dataset_name: Name for new dataset if save_as='dataset'
    """
    db = SessionLocal()
    
    try:
        # Get and validate task
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            logger.error(f"Task {task_id} not found")
            return
        
        if task.status == 'cancelled':
            logger.info(f"Task {task_id}: Task was cancelled")
            return
        
        # Update task to running
        task.status = 'running'
        task.started_at = datetime.utcnow()
        task.progress = 0.0
        db.commit()
        logger.info(f"Task {task_id}: Status set to running")
        
        # Get dataset
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise Exception(f"Dataset {dataset_id} not found")
        
        # Get source images (optional: restrict to one image collection via task_metadata)
        md = task.task_metadata or {}
        cid_raw = md.get("collection_id")
        cid = None
        if cid_raw is not None:
            try:
                cid = int(cid_raw)
            except (TypeError, ValueError):
                cid = None
        q_img = db.query(models.Image).filter(models.Image.dataset_id == dataset_id)
        if cid is not None:
            q_img = q_img.filter(models.Image.collection_id == cid)
        images = q_img.order_by(models.Image.id.asc()).all()
        logger.info(
            f"Task {task_id}: Found {len(images)} images to process"
            + (f" (collection_id={cid})" if cid is not None else " (all collections)")
        )
        
        if len(images) == 0:
            raise Exception("No images found in dataset")
        
        task.progress = 5.0
        db.commit()
        
        # Load depth model
        session = load_depth_model(model_size, environment, task_id)
        task.progress = 10.0
        db.commit()
        
        # Determine output location
        project_id = dataset.project_id or 0
        
        if save_as == "dataset":
            # Create new dataset
            new_dataset = models.Dataset(
                name=new_dataset_name or f"{dataset.name} - Depth {environment.capitalize()}",
                description=f"Depth maps generated from {dataset.name} using Depth-Anything-V2 {model_size} ({environment})",
                project_id=dataset.project_id,
                tags=["depth", "depth_anything_v2", model_size, environment, "generated"]
            )
            db.add(new_dataset)
            db.commit()
            db.refresh(new_dataset)
            
            target_dataset_id = new_dataset.id
            output_base_dir = Path("projects") / str(project_id) / str(target_dataset_id) / "images"
            
            # Create default collection for new dataset
            default_collection = models.ImageCollection(
                dataset_id=target_dataset_id,
                name="Depth Maps",
                description="Monocular depth estimation maps",
                is_default=True
            )
            db.add(default_collection)
            db.commit()
            db.refresh(default_collection)
            target_collection_id = default_collection.id
            
            logger.info(f"Task {task_id}: Created new dataset {target_dataset_id}")
        else:
            # Create new collection in existing dataset
            collection_name = f"Depth {environment.capitalize()} ({model_size})"
            new_collection = models.ImageCollection(
                dataset_id=dataset_id,
                name=collection_name,
                description=f"Depth maps using Depth-Anything-V2 {model_size} ({environment})",
                is_default=False
            )
            db.add(new_collection)
            db.commit()
            db.refresh(new_collection)
            
            target_dataset_id = dataset_id
            target_collection_id = new_collection.id
            # IMPORTANT: write depth maps into a per-collection subdirectory so we don't
            # overwrite RGB images (or other collections) that share the same filename.
            # Previously this used the flat `images/` dir, which caused e.g. depth outputs
            # to overwrite the source RGB files on disk.
            output_subdir = f"c{target_collection_id}"
            output_base_dir = Path("projects") / str(project_id) / str(dataset_id) / "images" / output_subdir

            logger.info(f"Task {task_id}: Created new collection {target_collection_id}")
        
        output_base_dir.mkdir(parents=True, exist_ok=True)
        task.progress = 15.0
        db.commit()
        
        # Process images
        processed_count = 0
        failed_count = 0
        
        for idx, img in enumerate(images):
            try:
                # Construct input path
                if img.url:
                    # Remove '/static/' prefix if present
                    rel_path = img.url.replace('/static/', '')
                    input_path = Path(rel_path)
                else:
                    input_path = Path("projects") / str(project_id) / str(dataset_id) / "images" / img.file_name
                
                if not input_path.exists():
                    logger.warning(f"Task {task_id}: Image file not found: {input_path}")
                    failed_count += 1
                    continue
                
                # Generate output filename (same name as input, .png for depth map)
                name_parts = img.file_name.rsplit('.', 1)
                output_filename = f"{name_parts[0]}.png"
                output_path = output_base_dir / output_filename
                
                # Process image
                width, height = process_single_image_depth(session, input_path, output_path, task_id)
                
                if width > 0 and height > 0:
                    # Build URL that matches where we actually wrote the file. For
                    # save_as="collection" this is now a subdirectory (c{collection_id}) to
                    # avoid colliding with the source RGB images; save_as="dataset" still
                    # uses the flat images/ directory of the newly-created dataset.
                    if save_as == "dataset":
                        relative_url = f"/static/projects/{project_id}/{target_dataset_id}/images/{output_filename}"
                    else:
                        relative_url = f"/static/projects/{project_id}/{target_dataset_id}/images/{output_subdir}/{output_filename}"

                    new_image = models.Image(
                        dataset_id=target_dataset_id,
                        collection_id=target_collection_id,
                        file_name=output_filename,
                        file_size=output_path.stat().st_size,
                        width=width,
                        height=height,
                        url=relative_url,
                        thumbnail_url=relative_url,
                        uploaded_at=datetime.utcnow()
                    )
                    db.add(new_image)
                    processed_count += 1
                else:
                    failed_count += 1
                
                # Update progress
                if (idx + 1) % 5 == 0 or (idx + 1) == len(images):
                    progress = 15.0 + ((idx + 1) / len(images)) * 80.0
                    task.progress = progress
                    db.commit()
                    logger.info(f"Task {task_id}: Processed {idx + 1}/{len(images)} images")
                
            except Exception as e:
                logger.error(f"Task {task_id}: Error processing image {img.file_name}: {e}")
                failed_count += 1
        
        db.commit()
        
        # Update dataset/collection counts
        if save_as == "dataset":
            new_dataset.image_count = processed_count
            db.commit()
        
        # Complete task
        task.status = 'completed'
        task.progress = 100.0
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **task.task_metadata,
            'processed_images': processed_count,
            'failed_images': failed_count,
            'output_dataset_id' if save_as == "dataset" else 'output_collection_id': 
                target_dataset_id if save_as == "dataset" else target_collection_id
        }
        db.commit()
        logger.info(f"Task {task_id}: Completed with {processed_count} depth maps generated, {failed_count} failed")
        
    except Exception as e:
        logger.error(f"Task {task_id}: Error - {str(e)}", exc_info=True)
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if task and task.status != 'cancelled':
            task.status = 'failed'
            task.error_message = str(e)
            task.completed_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
