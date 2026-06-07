"""
Celery tasks for model evaluation.
"""
import os
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple
from collections import deque
from concurrent.futures import ThreadPoolExecutor, Future
import numpy as np
import time
from PIL import Image as PILImage

from celery import Task
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.celery.gpu_app import celery_app
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.evaluation_artifacts import write_evaluation_blobs
from app.models import Task as TaskModel, Annotation, AnnotationClass, AnnotationFile, Dataset, Image
from app.tasks.evaluation_helpers import (
    extract_yolo_image_predictions,
    resolve_evaluation_class_names,
    resolve_evaluation_imgsz,
)

logger = logging.getLogger(__name__)

# -------------------------
# Evaluation batching helpers
# -------------------------

def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def _choose_eval_batch_size(imgsz: int = 640, half: bool = True) -> int:
    """
    Choose an evaluation batch size based on available GPU memory.

    Tuned to use ~70% of free VRAM. Memory scales quadratically with imgsz and
    halves with FP16. Override via LAI_EVAL_BATCH (int).
    """
    override = os.environ.get("LAI_EVAL_BATCH")
    if override:
        try:
            v = int(override)
            return max(1, v)
        except Exception:
            pass

    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return 1

        free_bytes, _total_bytes = torch.cuda.mem_get_info()
        free_gb = free_bytes / (1024**3)
        # Memory scales ~quadratically with image size, ~half with FP16.
        imgsz_scale = max(1.0, (float(imgsz) / 640.0) ** 2)
        half_scale = 0.55 if half else 1.0
        # Empirical per-image VRAM cost at 640 fp16 for YOLO-N..L: ~25-50MB
        # (activations + NMS + I/O buffers). Pick a safe midpoint and let the
        # OOM-backoff in the predict loop correct it if a model is heavier.
        per_img_mb = 35.0 * imgsz_scale * half_scale
        budget_mb = max(0.0, free_gb * 1024.0 * 0.7)  # 70% of free VRAM
        base = int(budget_mb / max(1.0, per_img_mb))
        # Sensible floor and ceiling.
        return max(8, min(512, base))
    except Exception:
        return 8


def _chunked(seq, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _get_gpu_mem_info_gb() -> tuple[float, float]:
    """Return (free_gb, total_gb) for current CUDA device, or (0, 0)."""
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return 0.0, 0.0
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        return free_bytes / (1024**3), total_bytes / (1024**3)
    except Exception:
        return 0.0, 0.0


def _resolve_eval_device() -> str:
    """
    Resolve target inference device.

    Honors LAI_EVAL_DEVICE (e.g. "0", "cpu", "cuda:0"). Defaults to GPU 0 when
    CUDA is available, else "cpu".
    """
    override = (os.environ.get("LAI_EVAL_DEVICE") or "").strip()
    if override:
        return override
    try:
        import torch  # type: ignore
        return "0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _decode_image_bgr(path: str) -> Optional[np.ndarray]:
    """Decode an image to a BGR numpy array. Returns None on failure.

    Tries OpenCV first (fastest, releases GIL), falls back to PIL.
    """
    try:
        import cv2  # type: ignore

        arr = cv2.imread(path, cv2.IMREAD_COLOR)
        if arr is not None:
            return arr
    except Exception:
        pass

    try:
        with PILImage.open(path) as pil:
            rgb = np.array(pil.convert("RGB"))
        # Convert RGB -> BGR for Ultralytics (matches cv2 convention).
        return rgb[:, :, ::-1].copy()
    except Exception as e:
        logger.warning("Failed to decode image %s: %s", path, e)
        return None


def _iter_prefetched_chunks(
    items: List[Tuple[Image, Path]],
    get_batch_size,
    decode_workers: int,
    prefetch: int,
):
    """
    Yield (chunk_items, decoded_arrays) batches with parallel decoding and
    overlap of next-chunk prefetch with current-chunk GPU work.

    `get_batch_size()` is consulted at submit time so that ramp-up/backoff
    in the predict loop affects subsequent chunks.
    """
    if not items:
        return

    decode_workers = max(1, decode_workers)
    prefetch = max(1, prefetch)
    pool = ThreadPoolExecutor(
        max_workers=decode_workers,
        thread_name_prefix="lai-eval-decode",
    )
    pending: deque[Tuple[List[Tuple[Image, Path]], List[Future]]] = deque()
    pos = 0

    def _submit_next() -> bool:
        nonlocal pos
        if pos >= len(items):
            return False
        try:
            size = max(1, int(get_batch_size()))
        except Exception:
            size = 1
        chunk = items[pos : pos + size]
        pos += len(chunk)
        futures = [pool.submit(_decode_image_bgr, str(p)) for (_img, p) in chunk]
        pending.append((chunk, futures))
        return True

    try:
        for _ in range(prefetch):
            if not _submit_next():
                break

        while pending:
            chunk, futures = pending.popleft()
            arrays = [f.result() for f in futures]
            yield chunk, arrays
            _submit_next()
    finally:
        pool.shutdown(wait=True)

# Database setup for Celery workers
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres:postgres@db/lai_db')
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def _resolve_evaluation_image_path(
    img: Image,
    project_id: int,
    dataset_id: int,
    collection_id: Optional[int] = None,
) -> Optional[Path]:
    """
    Resolve on-disk path for evaluation (delegates to dataset_media_paths).
    Handles collection subfolders (c<id>/), URL-derived paths, and filesystem
    drift after dataset moves (files under a different project folder).
    """
    return resolve_dataset_image_path_from_models(
        img,
        dataset_id=int(dataset_id),
        project_id=int(project_id),
        collection_id=collection_id,
    )


class EvaluationTask(Task):
    """Base task for evaluation with progress tracking"""
    
    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Called when task fails"""
        logger.error(f"Evaluation task {task_id} failed: {exc}")
        
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


def calculate_iou(box1: List[float], box2: List[float]) -> float:
    """Calculate IoU between two boxes [x1, y1, x2, y2]"""
    x1 = max(box1[0], box2[0])
    y1 = max(box1[1], box2[1])
    x2 = min(box1[2], box2[2])
    y2 = min(box1[3], box2[3])
    
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
    area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
    union = area1 + area2 - intersection
    
    return intersection / union if union > 0 else 0


def generate_grid_tiles(image_width: int, image_height: int, tile_size: int, overlap: float) -> List[Dict[str, int]]:
    """
    Generate grid tiles with overlap for an image
    Returns list of tiles with coordinates: [{x, y, width, height}, ...]
    """
    tiles = []
    stride = int(tile_size * (1 - overlap))
    
    for y in range(0, image_height, stride):
        for x in range(0, image_width, stride):
            # Calculate tile bounds
            tile_x = x
            tile_y = y
            tile_w = min(tile_size, image_width - x)
            tile_h = min(tile_size, image_height - y)
            
            # Only add tiles that are at least 50% of the tile_size in both dimensions
            if tile_w >= tile_size * 0.5 and tile_h >= tile_size * 0.5:
                tiles.append({
                    'x': tile_x,
                    'y': tile_y,
                    'width': tile_w,
                    'height': tile_h
                })
    
    return tiles


def nms_predictions(predictions: List[Dict], iou_threshold: float = 0.5) -> List[Dict]:
    """
    Apply Non-Maximum Suppression to merge overlapping predictions from grid tiles
    """
    if not predictions:
        return []
    
    # Sort by confidence score (descending)
    predictions = sorted(predictions, key=lambda x: x['conf'], reverse=True)
    
    keep = []
    while predictions:
        # Take the prediction with highest confidence
        current = predictions.pop(0)
        keep.append(current)
        
        # Remove predictions that overlap significantly with current
        filtered = []
        for pred in predictions:
            # Only compare predictions of the same class
            if pred['class_id'] != current['class_id']:
                filtered.append(pred)
                continue
            
            # Calculate IoU
            iou = calculate_iou(current['bbox_xyxy'], pred['bbox_xyxy'])
            
            # Keep if IoU is below threshold
            if iou < iou_threshold:
                filtered.append(pred)
        
        predictions = filtered
    
    return keep


@celery_app.task(base=EvaluationTask, bind=True, name='app.tasks.evaluation_tasks.evaluate_model')
def evaluate_model(
    self,
    task_id: int,
    training_task_id: int,
    dataset_id: int,
    annotation_file_id: Optional[str],
    checkpoint: str,
    conf_threshold: float,
    iou_threshold: float,
    nms_iou_threshold: float = 0.45,
    use_grid: bool = False,
    grid_size: int = 640,
    grid_overlap: float = 0.2,
    collection_id: Optional[int] = None,
    ignored_classes: Optional[List[str]] = None,
    image_size: Optional[int] = None,
):
    """
    Run model evaluation as a background task
    Supports grid-based inference for high-resolution images
    
    Args:
        conf_threshold: Minimum confidence score for predictions
        iou_threshold: IoU threshold for matching predictions to ground truth
        nms_iou_threshold: IoU threshold for Non-Maximum Suppression (default 0.45)
        ignored_classes: List of class names to ignore when calculating metrics
    """
    db = SessionLocal()
    task = None
    
    try:
        # Get the task record
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")
        
        # Update task status
        task.status = 'running'
        task.progress = 0
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'initializing',
            'celery_task_id': self.request.id
        }
        db.commit()
        
        from app.tasks.training_common import get_ultralytics_yolo
        YOLO = get_ultralytics_yolo()
        # Get the training task
        training_task = db.query(TaskModel).filter(TaskModel.id == training_task_id).first()
        if not training_task or training_task.status != 'completed':
            raise ValueError("Training task not found or not completed")

        from app.ml.dispatch import get_model_backend

        eval_backend = get_model_backend(training_task)
        if eval_backend.runtime_profile == "mmyolo":
            from app.tasks.mmyolo_evaluation import run_mmyolo_evaluation

            return run_mmyolo_evaluation(
                self,
                db,
                task,
                training_task,
                training_task_id=training_task_id,
                dataset_id=dataset_id,
                annotation_file_id=annotation_file_id,
                checkpoint=checkpoint,
                conf_threshold=conf_threshold,
                iou_threshold=iou_threshold,
                nms_iou_threshold=nms_iou_threshold,
                use_grid=use_grid,
                grid_size=grid_size,
                grid_overlap=grid_overlap,
                collection_id=collection_id,
                ignored_classes=ignored_classes,
                image_size=image_size,
            )
        
        # Get model path from training task metadata
        task_metadata = training_task.task_metadata or {}
        model_path = None
        
        if checkpoint == "best":
            model_path = task_metadata.get('best_model')
        else:
            last_model = task_metadata.get('last_model')
            if last_model:
                model_path = last_model
            elif task_metadata.get('results_dir'):
                model_path = str(Path(task_metadata['results_dir']) / "weights" / "last.pt")
        
        if not model_path or not Path(model_path).exists():
            raise ValueError(f"Model checkpoint '{checkpoint}' not found")
        
        logger.info(f"Loading model from {model_path}")
        task.progress = 10
        task.task_metadata = {**task.task_metadata, 'stage': 'loading_model'}
        db.commit()
        
        # Load model
        model = YOLO(model_path)
        
        # Detect model type (detection vs segmentation)
        model_task_type = getattr(model, 'task', 'detect')
        is_segmentation_model = 'seg' in str(model_path).lower() or model_task_type == 'segment'
        if model_task_type == 'classify':
            raise ValueError(
                "Classification models cannot be evaluated with the detection evaluation pipeline. "
                "Use a detect or segment checkpoint."
            )
        logger.info(f"Model type: {model_task_type}, is_segmentation: {is_segmentation_model}, path: {model_path}")
        
        # Get dataset
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            raise ValueError("Dataset not found")
        
        # Prefer checkpoint model.names / nc; training metadata can be stale.
        class_names, num_classes = resolve_evaluation_class_names(model, task_metadata)
        logger.info("Evaluation classes: nc=%s names=%s", num_classes, class_names)
        
        task.progress = 20
        task.task_metadata = {**task.task_metadata, 'stage': 'loading_annotations'}
        db.commit()
        
        # Check if ground truth is available
        has_ground_truth = False
        ground_truth_annotations = {}
        
        if annotation_file_id:
            annotation_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == annotation_file_id
            ).first()
            
            if annotation_file:
                has_ground_truth = True
                annotations = db.query(Annotation).filter(
                    Annotation.annotation_file_id == annotation_file_id
                ).all()
                
                logger.info(f"Loading {len(annotations)} ground truth annotations from annotation file {annotation_file_id}")

                # Build a map of image_id → (width, height) for denormalization
                ann_image_ids = {ann.image_id for ann in annotations}
                image_dims = {
                    img.id: (img.width or 1, img.height or 1)
                    for img in db.query(Image).filter(Image.id.in_(ann_image_ids)).all()
                }
                
                for ann in annotations:
                    if ann.image_id not in ground_truth_annotations:
                        ground_truth_annotations[ann.image_id] = []
                    
                    img_w, img_h = image_dims.get(ann.image_id, (1, 1))

                    # Get bbox — bbox_x/y/width/height are stored NORMALIZED (0-1).
                    # The legacy ann.bbox JSON field may be absolute pixels (COCO [x,y,w,h]).
                    bbox_x, bbox_y, bbox_width, bbox_height = None, None, None, None
                    if ann.bbox_x is not None and ann.bbox_y is not None and ann.bbox_width is not None and ann.bbox_height is not None:
                        # Denormalize to absolute pixel coordinates
                        bbox_x  = ann.bbox_x     * img_w
                        bbox_y  = ann.bbox_y     * img_h
                        bbox_width  = ann.bbox_width  * img_w
                        bbox_height = ann.bbox_height * img_h
                    elif ann.bbox and isinstance(ann.bbox, list) and len(ann.bbox) >= 4:
                        # Legacy JSON bbox — already absolute pixel coords [x, y, w, h]
                        bbox_x, bbox_y = ann.bbox[0], ann.bbox[1]
                        bbox_width, bbox_height = ann.bbox[2], ann.bbox[3]
                    
                    # Skip annotations with missing bbox data
                    if bbox_x is None or bbox_y is None or bbox_width is None or bbox_height is None:
                        logger.warning(f"Skipping annotation {ann.id} with incomplete bbox data")
                        continue
                    
                    # Use category (class name) directly from annotation
                    # Case-insensitive match to handle e.g. "Car" vs "car"
                    class_id = -1
                    if ann.category:
                        ann_cat_lower = ann.category.lower()
                        for idx_cn, cn in enumerate(class_names):
                            if cn.lower() == ann_cat_lower:
                                class_id = idx_cn
                                break
                        if class_id == -1:
                            logger.warning(
                                f"GT category '{ann.category}' not found in training class_names "
                                f"{class_names} (case-insensitive) - annotation excluded from metrics"
                            )
                    
                    ground_truth_annotations[ann.image_id].append({
                        'class_id': class_id,
                        'bbox': [bbox_x, bbox_y,
                                 bbox_x + bbox_width,
                                 bbox_y + bbox_height]
                    })
            else:
                logger.warning(f"Annotation file {annotation_file_id} not found")
        else:
            logger.info("No annotation file specified - metrics will not be calculated")
        
        task.progress = 30
        task.task_metadata = {**task.task_metadata, 'stage': 'running_inference'}
        db.commit()
        
        # Get images
        images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
        if collection_id is not None:
            images_query = images_query.filter(Image.collection_id == collection_id)
        images = images_query.all()
        if not images:
            if collection_id is not None:
                raise ValueError(f"No images found in dataset for collection_id={collection_id}")
            raise ValueError("No images found in dataset")
        
        # Map image_id → file_name for frontend threshold explorer
        image_id_to_filename = {img.id: img.file_name for img in images}
        
        # Get project_id for constructing image paths
        project_id = dataset.project_id
        if not project_id:
            raise ValueError("Dataset does not belong to a project")

        # Warn if GT image IDs don't overlap with eval dataset image IDs at all
        if has_ground_truth and ground_truth_annotations:
            eval_image_ids = {img.id for img in images}
            gt_image_ids = set(ground_truth_annotations.keys())
            overlap = gt_image_ids & eval_image_ids
            logger.info(
                f"GT covers {len(gt_image_ids)} images, eval dataset has {len(eval_image_ids)} images, "
                f"overlap={len(overlap)}"
            )
            if not overlap:
                logger.error(
                    f"ZERO overlap between GT image IDs {sorted(gt_image_ids)[:5]} and "
                    f"eval image IDs {sorted(eval_image_ids)[:5]}. "
                    "precision/recall will be 0 — the annotation file may belong to a different "
                    "collection or dataset."
                )

        # Determine which class IDs to ignore based on ignored_classes list
        ignored_class_ids = set()
        if ignored_classes:
            for class_name in ignored_classes:
                if class_name in class_names:
                    ignored_class_ids.add(class_names.index(class_name))
            logger.info(f"Ignoring classes for metrics: {ignored_classes} (IDs: {ignored_class_ids})")
        
        # Initialize metrics
        # Size is (num_classes + 1) x (num_classes + 1): the extra row/column at index
        # num_classes represents "background" (unmatched predictions / missed GT boxes)
        confusion_matrix = np.zeros((num_classes + 1, num_classes + 1), dtype=int)
        true_positives = 0
        false_positives = 0
        false_negatives = 0
        predictions_count = 0
        filtered_by_class_total = 0
        raw_box_total = 0
        
        # Per-cell samples for interactive confusion matrix drill-down
        # Key: "row_col", value: list of up to MAX_CM_SAMPLES example dicts
        MAX_CM_SAMPLES = 20
        cm_samples: dict = {}

        def _add_cm_sample(row: int, col: int, sample: dict):
            key = f"{row}_{col}"
            if key not in cm_samples:
                cm_samples[key] = []
            if len(cm_samples[key]) < MAX_CM_SAMPLES:
                cm_samples[key].append(sample)
        
        # Store all predictions with bboxes and segmentation masks
        all_predictions = []
        
        start_time = time.time()
        total_images = len(images)
        eval_imgsz, eval_imgsz_source = resolve_evaluation_imgsz(task_metadata, image_size)

        # Inference path:
        # - grid mode: keep existing per-image/tile behavior
        # - non-grid: run model.predict on batches of image paths
        if use_grid:
            # Run inference on each image
            for idx, img in enumerate(images):
                img_path = _resolve_evaluation_image_path(img, project_id, dataset_id, collection_id)
                if img_path is None:
                    logger.warning(
                        "Image file not found for evaluation: file=%s dataset_id=%s project_id=%s url=%s",
                        img.file_name,
                        dataset_id,
                        project_id,
                        getattr(img, "url", None),
                    )
                    continue

                # Store predictions for this image with bbox and segmentation
                image_predictions = []

                # Grid-based inference
                # Load image to get dimensions
                try:
                    pil_image = PILImage.open(img_path)
                    image_width, image_height = pil_image.size
                except Exception as e:
                    logger.warning(f"Failed to load image {img_path}: {e}")
                    continue

                # Create grid_images directory
                grid_output_dir = Path("projects") / str(project_id) / "training" / f"task_{training_task_id}" / "grid_images"
                grid_output_dir.mkdir(parents=True, exist_ok=True)

                # Generate grid tiles
                tiles = generate_grid_tiles(image_width, image_height, grid_size, grid_overlap)

                # Run inference on each tile
                for tile_idx, tile in enumerate(tiles):
                    tile_image = pil_image.crop((
                        tile['x'],
                        tile['y'],
                        tile['x'] + tile['width'],
                        tile['y'] + tile['height']
                    ))

                    try:
                        results = model.predict(
                            source=np.array(tile_image),
                            conf=conf_threshold,
                            iou=nms_iou_threshold,
                            verbose=False,
                            save=False
                        )
                    except Exception as e:
                        logger.warning(f"Failed to run inference on tile {tile_idx} of {img_path}: {e}")
                        continue

                    if not results or len(results) == 0:
                        continue

                    result = results[0]

                    preds, raw_n, dropped_n = extract_yolo_image_predictions(
                        result,
                        image_id=img.id,
                        num_classes=num_classes,
                        is_segmentation_model=is_segmentation_model,
                        conf_threshold=0.0,
                    )
                    raw_box_total += raw_n
                    filtered_by_class_total += dropped_n
                    for pred in preds:
                        x, y, w, h = pred["bbox"]
                        pred["bbox"] = [
                            float(tile["x"] + x),
                            float(tile["y"] + y),
                            float(w),
                            float(h),
                        ]
                        if pred.get("bbox_xyxy"):
                            x1, y1, x2, y2 = pred["bbox_xyxy"]
                            pred["bbox_xyxy"] = [
                                float(tile["x"] + x1),
                                float(tile["y"] + y1),
                                float(tile["x"] + x2),
                                float(tile["y"] + y2),
                            ]
                        seg = pred.get("segmentation") or []
                        if seg and isinstance(seg[0], list):
                            pred["segmentation"] = [
                                [float(pt[0] + tile["x"]), float(pt[1] + tile["y"])]
                                for pt in seg
                            ]
                        image_predictions.append(pred)

                if image_predictions:
                    image_predictions = nms_predictions(image_predictions, iou_threshold=0.5)
                    predictions_count += len(image_predictions)

                # Store predictions for this image
                if image_predictions:
                    all_predictions.extend(image_predictions)

                # Metrics + progress (unchanged logic)
                if has_ground_truth and img.id in ground_truth_annotations:
                    gt_boxes = ground_truth_annotations[img.id]
                    pred_boxes = []

                    for pred in image_predictions:
                        pred_boxes.append({
                            'class_id': pred['class_id'],
                            'bbox': pred['bbox_xyxy'],
                            'conf': pred['conf']
                        })

                    filtered_pred_boxes = [p for p in pred_boxes if p['class_id'] not in ignored_class_ids]
                    filtered_gt_boxes = [g for g in gt_boxes if g['class_id'] not in ignored_class_ids and g['class_id'] >= 0]

                    matched_gt = set()
                    matched_pred = set()

                    for i, pred in enumerate(filtered_pred_boxes):
                        best_iou = 0
                        best_gt_idx = -1

                        for j, gt in enumerate(filtered_gt_boxes):
                            if j in matched_gt:
                                continue

                            iou = calculate_iou(pred['bbox'], gt['bbox'])
                            if iou > best_iou:
                                best_iou = iou
                                best_gt_idx = j

                        if best_iou >= iou_threshold:
                            matched_pred.add(i)
                            matched_gt.add(best_gt_idx)

                            gt_class = filtered_gt_boxes[best_gt_idx]['class_id']
                            pred_class = pred['class_id']

                            if gt_class >= 0 and pred_class >= 0:
                                confusion_matrix[gt_class][pred_class] += 1
                                _add_cm_sample(gt_class, pred_class, {
                                    'image_id': img.id,
                                    'file_name': img.file_name,
                                    'pred_bbox': pred['bbox'],
                                    'gt_bbox': filtered_gt_boxes[best_gt_idx]['bbox'],
                                    'pred_class_name': class_names[pred_class],
                                    'gt_class_name': class_names[gt_class],
                                    'conf': float(pred['conf']),
                                    'iou': float(best_iou),
                                })
                                if gt_class == pred_class:
                                    true_positives += 1
                                else:
                                    false_positives += 1
                        else:
                            false_positives += 1
                            if pred['class_id'] < num_classes:
                                confusion_matrix[num_classes][pred['class_id']] += 1
                                _add_cm_sample(num_classes, pred['class_id'], {
                                    'image_id': img.id,
                                    'file_name': img.file_name,
                                    'pred_bbox': pred['bbox'],
                                    'gt_bbox': None,
                                    'pred_class_name': class_names[pred['class_id']],
                                    'gt_class_name': 'background',
                                    'conf': float(pred['conf']),
                                    'iou': float(best_iou),
                                })

                    for j in range(len(filtered_gt_boxes)):
                        if j not in matched_gt:
                            gt_class = filtered_gt_boxes[j]['class_id']
                            if 0 <= gt_class < num_classes:
                                confusion_matrix[gt_class][num_classes] += 1
                                _add_cm_sample(gt_class, num_classes, {
                                    'image_id': img.id,
                                    'file_name': img.file_name,
                                    'pred_bbox': None,
                                    'gt_bbox': filtered_gt_boxes[j]['bbox'],
                                    'pred_class_name': 'background',
                                    'gt_class_name': class_names[gt_class],
                                    'conf': 0.0,
                                    'iou': 0.0,
                                })

                    false_negatives += len(filtered_gt_boxes) - len(matched_gt)

                elif has_ground_truth:
                    extra_fp = sum(1 for p in image_predictions if p['class_id'] not in ignored_class_ids)
                    false_positives += extra_fp

                if (idx + 1) % max(1, total_images // 10) == 0:
                    progress = 30 + int((idx + 1) / total_images * 60)
                    task.progress = progress
                    db.commit()

        else:
            # Batched full-image inference
            eval_half = _env_bool("LAI_EVAL_HALF", False)
            eval_device = _resolve_eval_device()
            eval_batch = _choose_eval_batch_size(imgsz=eval_imgsz, half=eval_half)
            max_batch = max(1, int(os.environ.get("LAI_EVAL_BATCH_MAX", "512") or 512))
            eval_batch = min(eval_batch, max_batch)
            decode_workers = max(
                1, int(os.environ.get("LAI_EVAL_DECODE_WORKERS", "8") or 8)
            )
            prefetch_chunks = max(
                1, int(os.environ.get("LAI_EVAL_PREFETCH_CHUNKS", "2") or 2)
            )
            free_gb, total_gb = _get_gpu_mem_info_gb()
            logger.info(
                "Evaluation batching: mode=batched imgsz=%s initial_batch=%s max_batch=%s "
                "half=%s device=%s decode_workers=%s prefetch=%s free_gpu=%.2fGB total_gpu=%.2fGB",
                eval_imgsz,
                eval_batch,
                max_batch,
                eval_half,
                eval_device,
                decode_workers,
                prefetch_chunks,
                free_gb,
                total_gb,
            )
            task.task_metadata = {
                **(task.task_metadata or {}),
                "eval_batch_size": eval_batch,
                "eval_imgsz": eval_imgsz,
                "eval_imgsz_source": eval_imgsz_source,
                "eval_half": eval_half,
                "eval_device": eval_device,
                "eval_decode_workers": decode_workers,
                "eval_prefetch_chunks": prefetch_chunks,
                "eval_gpu_free_gb": round(free_gb, 2),
                "eval_gpu_total_gb": round(total_gb, 2),
            }
            db.commit()

            valid_items: List[Tuple[Image, Path]] = []
            missing_paths = 0
            for img in images:
                img_path = _resolve_evaluation_image_path(img, project_id, dataset_id, collection_id)
                if img_path is None:
                    missing_paths += 1
                    logger.warning(
                        "Image file not found for evaluation: file=%s dataset_id=%s project_id=%s url=%s",
                        img.file_name,
                        dataset_id,
                        project_id,
                        getattr(img, "url", None),
                    )
                    continue
                valid_items.append((img, img_path))

            if not valid_items:
                raise ValueError(
                    f"No readable image files found for evaluation "
                    f"(dataset_id={dataset_id}, collection_id={collection_id}, "
                    f"total_images={len(images)}, missing_paths={missing_paths})"
                )

            # GPU warmup: cuDNN autotune + alloc pools cost is paid once instead
            # of on the first user batch (which would otherwise look like a hang).
            if eval_device != "cpu" and valid_items:
                try:
                    warmup_paths = [str(valid_items[0][1])]
                    model.predict(
                        source=warmup_paths,
                        conf=conf_threshold,
                        iou=nms_iou_threshold,
                        imgsz=eval_imgsz,
                        half=eval_half,
                        device=eval_device,
                        verbose=False,
                        batch=1,
                    )
                except Exception as e:
                    logger.debug("Warmup predict failed (non-fatal): %s", e)

            processed = 0
            successful_chunks = 0
            t_inference_start = time.time()

            # Batch by file path (same as auto-annotate). Decoded numpy batches were
            # unreliable across Ultralytics versions and channel-order edge cases.
            for chunk in _chunked(valid_items, eval_batch):
                infer_inputs = [str(p) for _img, p in chunk]
                run_batch = min(eval_batch, len(infer_inputs))
                results = None
                while run_batch >= 1:
                    try:
                        results = model.predict(
                            source=infer_inputs,
                            conf=conf_threshold,
                            iou=nms_iou_threshold,
                            imgsz=eval_imgsz,
                            half=eval_half,
                            device=eval_device,
                            verbose=False,
                            batch=run_batch,
                        )
                        successful_chunks += 1
                        if eval_batch < max_batch:
                            free_now, total_now = _get_gpu_mem_info_gb()
                            free_ratio = (free_now / total_now) if total_now > 0 else 0.0
                            if successful_chunks <= 3 and free_ratio > 0.35:
                                eval_batch = min(max_batch, eval_batch * 2)
                            elif free_ratio > 0.5:
                                eval_batch = min(max_batch, int(eval_batch * 1.5))
                        break
                    except Exception as e:
                        msg = str(e).lower()
                        oom_like = (
                            "out of memory" in msg
                            or "cuda error" in msg
                            or "cudnn" in msg
                        )
                        if oom_like and run_batch > 1:
                            run_batch = max(1, run_batch // 2)
                            eval_batch = run_batch
                            successful_chunks = 0
                            logger.warning(
                                "Evaluation batch OOM/backoff: retrying with batch=%s (task=%s)",
                                run_batch,
                                task_id,
                            )
                            try:
                                import torch  # type: ignore
                                torch.cuda.empty_cache()
                            except Exception:
                                pass
                            continue
                        logger.warning(
                            "Failed batched inference on %s images with batch=%s: %s",
                            len(infer_inputs),
                            run_batch,
                            e,
                        )
                        results = [None] * len(infer_inputs)
                        break

                if results is None:
                    results = [None] * len(infer_inputs)

                for (img, _img_path), result in zip(chunk, results):
                    image_predictions, raw_n, dropped_n = extract_yolo_image_predictions(
                        result,
                        image_id=img.id,
                        num_classes=num_classes,
                        is_segmentation_model=is_segmentation_model,
                        conf_threshold=0.0,
                    )
                    raw_box_total += raw_n
                    filtered_by_class_total += dropped_n
                    predictions_count += len(image_predictions)

                    if image_predictions:
                        all_predictions.extend(image_predictions)

                    if has_ground_truth and img.id in ground_truth_annotations:
                        gt_boxes = ground_truth_annotations[img.id]
                        pred_boxes = []
                        for pred in image_predictions:
                            pred_boxes.append({
                                'class_id': pred['class_id'],
                                'bbox': pred['bbox_xyxy'],
                                'conf': pred['conf']
                            })

                        filtered_pred_boxes = [p for p in pred_boxes if p['class_id'] not in ignored_class_ids]
                        filtered_gt_boxes = [g for g in gt_boxes if g['class_id'] not in ignored_class_ids and g['class_id'] >= 0]

                        matched_gt = set()
                        matched_pred = set()

                        for i, pred in enumerate(filtered_pred_boxes):
                            best_iou = 0
                            best_gt_idx = -1
                            for j, gt in enumerate(filtered_gt_boxes):
                                if j in matched_gt:
                                    continue
                                iou = calculate_iou(pred['bbox'], gt['bbox'])
                                if iou > best_iou:
                                    best_iou = iou
                                    best_gt_idx = j

                            if best_iou >= iou_threshold:
                                matched_pred.add(i)
                                matched_gt.add(best_gt_idx)
                                gt_class = filtered_gt_boxes[best_gt_idx]['class_id']
                                pred_class = pred['class_id']
                                if gt_class >= 0 and pred_class >= 0:
                                    confusion_matrix[gt_class][pred_class] += 1
                                    _add_cm_sample(gt_class, pred_class, {
                                        'image_id': img.id,
                                        'file_name': img.file_name,
                                        'pred_bbox': pred['bbox'],
                                        'gt_bbox': filtered_gt_boxes[best_gt_idx]['bbox'],
                                        'pred_class_name': class_names[pred_class],
                                        'gt_class_name': class_names[gt_class],
                                        'conf': float(pred['conf']),
                                        'iou': float(best_iou),
                                    })
                                    if gt_class == pred_class:
                                        true_positives += 1
                                    else:
                                        false_positives += 1
                            else:
                                false_positives += 1
                                if pred['class_id'] < num_classes:
                                    confusion_matrix[num_classes][pred['class_id']] += 1
                                    _add_cm_sample(num_classes, pred['class_id'], {
                                        'image_id': img.id,
                                        'file_name': img.file_name,
                                        'pred_bbox': pred['bbox'],
                                        'gt_bbox': None,
                                        'pred_class_name': class_names[pred['class_id']],
                                        'gt_class_name': 'background',
                                        'conf': float(pred['conf']),
                                        'iou': float(best_iou),
                                    })

                        for j in range(len(filtered_gt_boxes)):
                            if j not in matched_gt:
                                gt_class = filtered_gt_boxes[j]['class_id']
                                if 0 <= gt_class < num_classes:
                                    confusion_matrix[gt_class][num_classes] += 1
                                    _add_cm_sample(gt_class, num_classes, {
                                        'image_id': img.id,
                                        'file_name': img.file_name,
                                        'pred_bbox': None,
                                        'gt_bbox': filtered_gt_boxes[j]['bbox'],
                                        'pred_class_name': 'background',
                                        'gt_class_name': class_names[gt_class],
                                        'conf': 0.0,
                                        'iou': 0.0,
                                    })

                        false_negatives += len(filtered_gt_boxes) - len(matched_gt)

                    elif has_ground_truth:
                        extra_fp = sum(1 for p in image_predictions if p['class_id'] not in ignored_class_ids)
                        false_positives += extra_fp

                    processed += 1
                    if processed % max(1, total_images // 10) == 0:
                        progress = 30 + int(processed / max(1, total_images) * 60)
                        task.progress = progress
                        db.commit()

            # Final throughput summary so we can see batch ramp-up effect.
            try:
                infer_dt = max(1e-6, time.time() - t_inference_start)
                logger.info(
                    "Evaluation finished: images=%s final_batch=%s elapsed=%.2fs "
                    "throughput=%.1f img/s",
                    processed,
                    eval_batch,
                    infer_dt,
                    processed / infer_dt,
                )
                task.task_metadata = {
                    **(task.task_metadata or {}),
                    "eval_final_batch_size": eval_batch,
                    "eval_throughput_img_per_s": round(processed / infer_dt, 2),
                }
                db.commit()
            except Exception:
                pass

        inference_time_ms = (time.time() - start_time) * 1000
        
        # Build flat ground-truth list for frontend threshold explorer
        # (xyxy pixel coords, class_id, file_name per box)
        all_ground_truth = []
        if has_ground_truth:
            for img_id, gt_list in ground_truth_annotations.items():
                fname = image_id_to_filename.get(img_id, '')
                for box in gt_list:
                    cid = box['class_id']
                    if 0 <= cid < num_classes:
                        all_ground_truth.append({
                            'image_id': img_id,
                            'file_name': fname,
                            'class_id': cid,
                            'bbox': box['bbox'],   # [x1,y1,x2,y2] pixel coords
                            'class_name': class_names[cid],
                        })
        
        task.progress = 95
        task.task_metadata = {**task.task_metadata, 'stage': 'calculating_metrics'}
        db.commit()
        
        # Calculate final metrics
        logger.info(f"Final counts: TP={true_positives}, FP={false_positives}, FN={false_negatives}")
        if raw_box_total > 0 and predictions_count == 0:
            logger.error(
                "Evaluation produced 0 stored predictions but %s raw detections "
                "(%s dropped by class filter, nc=%s, names=%s)",
                raw_box_total,
                filtered_by_class_total,
                num_classes,
                class_names,
            )
        elif filtered_by_class_total > 0:
            logger.warning(
                "Dropped %s/%s detections outside model class range (nc=%s)",
                filtered_by_class_total,
                raw_box_total,
                num_classes,
            )
        precision = true_positives / (true_positives + false_positives) if (true_positives + false_positives) > 0 else 0.0
        recall = true_positives / (true_positives + false_negatives) if (true_positives + false_negatives) > 0 else 0.0
        f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
        logger.info(f"Metrics: Precision={precision:.3f}, Recall={recall:.3f}, F1={f1_score:.3f}")
        
        # Stats that do not require ground truth
        avg_confidence = 0.0
        predictions_per_image = 0.0
        class_prediction_counts: Dict[str, int] = {}
        if all_predictions:
            avg_confidence = float(
                sum(float(p.get('conf', 0.0)) for p in all_predictions) / len(all_predictions)
            )
            if total_images > 0:
                predictions_per_image = float(len(all_predictions) / total_images)
            for p in all_predictions:
                class_id = int(p.get('class_id', -1))
                if 0 <= class_id < len(class_names):
                    class_name = class_names[class_id]
                    class_prediction_counts[class_name] = class_prediction_counts.get(class_name, 0) + 1

        # Store results in task metadata (heavy lists go to disk — see artifacts)
        # Check if any predictions have segmentation masks
        predictions_with_masks = sum(1 for pred in all_predictions if pred.get('segmentation') and len(pred.get('segmentation', [])) > 0)
        if is_segmentation_model:
            logger.info(f"Segmentation model: {predictions_with_masks}/{len(all_predictions)} predictions have masks")
            if predictions_with_masks == 0 and len(all_predictions) > 0:
                logger.warning(f"Segmentation model produced NO masks! Model path: {model_path}")
        
        results = {
            'precision': float(precision),
            'recall': float(recall),
            'f1_score': float(f1_score),
            'map50': 0.0,
            'map50_95': 0.0,
            'confusion_matrix': confusion_matrix.tolist(),
            'class_names': class_names + ['background'],  # background = unmatched row/col
            'project_id': project_id,
            'image_id_to_filename': {str(k): v for k, v in image_id_to_filename.items()},
            'predictions_count': predictions_count,
            'raw_detection_count': raw_box_total,
            'filtered_detection_count': filtered_by_class_total,
            'eval_imgsz': eval_imgsz,
            'eval_imgsz_source': eval_imgsz_source,
            'has_ground_truth': has_ground_truth,
            'avg_confidence': avg_confidence,
            'predictions_per_image': predictions_per_image,
            'class_prediction_counts': class_prediction_counts,
            'inference_time_ms': float(inference_time_ms),
            'images_processed': total_images,
            'training_task_id': training_task_id,
            'dataset_id': dataset_id,
            'collection_id': collection_id,
            'checkpoint': checkpoint,
            'conf_threshold': conf_threshold,
            'iou_threshold': iou_threshold,
            'nms_iou_threshold': nms_iou_threshold,
            'use_grid': use_grid,
            'grid_size': grid_size if use_grid else None,
            'grid_overlap': grid_overlap if use_grid else None,
        }
        if all_predictions or all_ground_truth or cm_samples:
            blobs_rel = write_evaluation_blobs(
                project_id,
                task_id,
                all_predictions,
                all_ground_truth,
                cm_samples,
            )
            results['artifacts'] = {'blobs': blobs_rel, 'format_version': 1}
        
        task.status = 'completed'
        task.progress = 100
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **task.task_metadata,
            'stage': 'completed',
            'results': results
        }
        db.commit()
        
        # Update parent task if this is a child task
        parent_task_id = task.task_metadata.get('parent_task_id')
        if parent_task_id:
            update_parent_task_status(db, parent_task_id)
        
        logger.info(f"Evaluation completed: {predictions_count} predictions on {total_images} images")
        return results
        
    except Exception as e:
        logger.error(f"Error in evaluation task: {str(e)}", exc_info=True)
        if task is not None:
            task.status = 'failed'
            task.completed_at = datetime.utcnow()
            task.error_message = f"Evaluation error: {str(e)}"
            db.commit()
            parent_task_id = task.task_metadata.get('parent_task_id') if task.task_metadata else None
            if parent_task_id:
                update_parent_task_status(db, parent_task_id)
        
        raise
    finally:
        db.close()


def update_parent_task_status(db, parent_task_id: int):
    """Update the parent task status based on child task statuses"""
    try:
        parent_task = db.query(TaskModel).filter(TaskModel.id == parent_task_id).first()
        if not parent_task:
            return
        
        parent_metadata = parent_task.task_metadata or {}
        child_task_ids = parent_metadata.get('child_task_ids', [])
        
        if not child_task_ids:
            return
        
        # Get all child tasks
        child_tasks = db.query(TaskModel).filter(TaskModel.id.in_(child_task_ids)).all()
        
        if not child_tasks:
            return
        
        # Calculate aggregate status
        completed_count = sum(1 for ct in child_tasks if ct.status == 'completed')
        failed_count = sum(1 for ct in child_tasks if ct.status == 'failed')
        running_count = sum(1 for ct in child_tasks if ct.status == 'running')
        total_count = len(child_tasks)
        
        # Calculate aggregate progress
        aggregate_progress = sum(ct.progress or 0 for ct in child_tasks) // total_count
        
        # Determine parent status
        if completed_count == total_count:
            parent_status = 'completed'
            parent_task.completed_at = datetime.utcnow()
        elif failed_count == total_count:
            parent_status = 'failed'
            parent_task.completed_at = datetime.utcnow()
        elif running_count > 0 or (completed_count + failed_count < total_count):
            parent_status = 'running'
        else:
            # Some completed, some failed
            parent_status = 'completed'  # Partial completion
            parent_task.completed_at = datetime.utcnow()
        
        # Aggregate results from completed children
        aggregate_results = None
        if completed_count > 0:
            completed_children = [ct for ct in child_tasks if ct.status == 'completed']
            total_images = sum(
                ct.task_metadata.get('results', {}).get('images_processed', 0) 
                for ct in completed_children if ct.task_metadata
            )
            total_predictions = sum(
                ct.task_metadata.get('results', {}).get('predictions_count', 0) 
                for ct in completed_children if ct.task_metadata
            )
            total_inference_time = sum(
                ct.task_metadata.get('results', {}).get('inference_time_ms', 0) 
                for ct in completed_children if ct.task_metadata
            )
            
            # Calculate average metrics only from children with ground truth.
            completed_with_gt = [
                ct for ct in completed_children
                if (ct.task_metadata or {}).get('results', {}).get('has_ground_truth') is True
            ]
            avg_precision = None
            avg_recall = None
            avg_f1 = None
            if completed_with_gt:
                gt_count = len(completed_with_gt)
                avg_precision = sum(
                    ct.task_metadata.get('results', {}).get('precision', 0)
                    for ct in completed_with_gt if ct.task_metadata
                ) / gt_count
                avg_recall = sum(
                    ct.task_metadata.get('results', {}).get('recall', 0)
                    for ct in completed_with_gt if ct.task_metadata
                ) / gt_count
                avg_f1 = sum(
                    ct.task_metadata.get('results', {}).get('f1_score', 0)
                    for ct in completed_with_gt if ct.task_metadata
                ) / gt_count

            # Prediction-only aggregate stats (valid even without ground truth)
            total_conf_weight = 0.0
            total_pred_for_conf = 0
            for ct in completed_children:
                results = (ct.task_metadata or {}).get('results', {})
                pred_count = int(results.get('predictions_count') or 0)
                avg_conf = float(results.get('avg_confidence') or 0.0)
                total_conf_weight += avg_conf * pred_count
                total_pred_for_conf += pred_count
            aggregate_avg_confidence = (total_conf_weight / total_pred_for_conf) if total_pred_for_conf > 0 else 0.0
            aggregate_predictions_per_image = (total_predictions / total_images) if total_images > 0 else 0.0
            
            aggregate_results = {
                'precision': avg_precision,
                'recall': avg_recall,
                'f1_score': avg_f1,
                'has_ground_truth': len(completed_with_gt) > 0,
                'images_processed': total_images,
                'predictions_count': total_predictions,
                'avg_confidence': aggregate_avg_confidence,
                'predictions_per_image': aggregate_predictions_per_image,
                'inference_time_ms': total_inference_time,
                'completed_datasets': completed_count,
                'failed_datasets': failed_count,
                'total_datasets': total_count
            }
        
        parent_task.status = parent_status
        parent_task.progress = aggregate_progress
        parent_task.task_metadata = {
            **parent_metadata,
            'aggregate_results': aggregate_results,
            'completed_count': completed_count,
            'failed_count': failed_count
        }
        db.commit()
        
        logger.info(f"Updated parent task {parent_task_id}: status={parent_status}, progress={aggregate_progress}%")
        
    except Exception as e:
        logger.error(f"Error updating parent task {parent_task_id}: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# MMYOLO single-image test inference (runs in celery_worker where MMYOLO lives)
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.evaluation_tasks.mmyolo_test_inference", ignore_result=False)
def mmyolo_test_inference(
    image_path: str,
    config_path: str,
    checkpoint_path: str,
    class_names: list,
    device: str = "cpu",
    dji_repo_dir: Optional[str] = None,
    conf_threshold: float = 0.25,
) -> dict:
    """
    Run MMYOLO inference on a single image inside the celery_worker container
    (where /opt/mmyolo-venv/bin/python exists).

    Returns a dict:  {"predictions": [...], "error": None | str}
    """
    from app.tasks.mmyolo_evaluation import (
        MMYOLO_INFERENCE_SCRIPT,
        _build_mmyolo_eval_env,
    )
    from app.tasks.training_common import MMYOLO_PYTHON
    import json
    import subprocess
    import tempfile

    if not Path(MMYOLO_PYTHON).exists():
        return {"predictions": [], "error": f"MMYOLO Python not found at {MMYOLO_PYTHON}"}

    try:
        with tempfile.TemporaryDirectory(prefix="mmyolo_test_inf_") as tmp:
            tmp_path = Path(tmp)
            input_json = tmp_path / "input.json"
            output_json = tmp_path / "output.json"

            input_json.write_text(
                json.dumps([{"image_id": 0, "path": str(image_path)}]),
                encoding="utf-8",
            )
            env = _build_mmyolo_eval_env(device=device, dji_repo_dir=dji_repo_dir)
            cmd = [
                MMYOLO_PYTHON,
                str(MMYOLO_INFERENCE_SCRIPT),
                "--config", str(config_path),
                "--checkpoint", str(checkpoint_path),
                "--input-json", str(input_json),
                "--output-json", str(output_json),
                "--num-classes", str(len(class_names)),
                "--conf", str(conf_threshold),
                "--device", device if device not in ("", None) else "cpu",
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "").strip()[-2000:]
                return {"predictions": [], "error": f"MMYOLO subprocess failed: {err}"}

            preds_raw = []
            if output_json.exists():
                preds_raw = json.loads(output_json.read_text(encoding="utf-8"))

            predictions = []
            for p in preds_raw:
                raw_xyxy = p.get("bbox_xyxy")
                if isinstance(raw_xyxy, list) and len(raw_xyxy) == 4:
                    x1, y1, x2, y2 = (float(v) for v in raw_xyxy[:4])
                    bbox_xywh = [x1, y1, x2 - x1, y2 - y1]
                elif isinstance(p.get("bbox"), list) and len(p["bbox"]) == 4:
                    bbox_xywh = [float(v) for v in p["bbox"][:4]]
                else:
                    bbox_xywh = []
                class_id = p.get("class_id", 0)
                class_name = (
                    class_names[class_id]
                    if class_id < len(class_names)
                    else f"class_{class_id}"
                )
                predictions.append({
                    "bbox": bbox_xywh,
                    "confidence": float(p.get("confidence", p.get("conf", 0))),
                    "class_id": class_id,
                    "class": class_name,
                    "segmentation": p.get("segmentation", []),
                })

            return {"predictions": predictions, "error": None}

    except Exception as exc:
        logger.error("mmyolo_test_inference task error: %s", exc, exc_info=True)
        return {"predictions": [], "error": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# Ultralytics single-image test inference (runs in celery_worker)
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.evaluation_tasks.yolo_test_inference", ignore_result=False)
def yolo_test_inference(
    image_path: str,
    model_path: str,
    class_names: list,
    conf_threshold: float = 0.25,
    device: str = "cpu",
) -> dict:
    """
    Run YOLO / RT-DETR inference on one image inside celery_worker
    (where /opt/ultralytics-site and PyTorch are available).

    Returns {"predictions": [...], "annotated_jpeg_base64": str|None, "error": str|None}
    """
    import base64

    from app.ml.ultralytics_compat import patch_ultralytics_lazy_exports
    from app.ml.runtime_env import ensure_ultralytics_sys_path

    patch_ultralytics_lazy_exports()
    ensure_ultralytics_sys_path()

    try:
        from ultralytics import YOLO
    except Exception as exc:
        return {
            "predictions": [],
            "annotated_jpeg_base64": None,
            "error": f"Ultralytics not available in worker: {exc}",
        }

    try:
        model = YOLO(model_path)
        results = model(
            image_path,
            conf=conf_threshold,
            iou=0.45,
            device=device if device not in ("", None) else "cpu",
        )

        predictions: List[Dict[str, Any]] = []
        annotated_b64: Optional[str] = None

        if results and len(results) > 0:
            result = results[0]
            annotated_img = result.plot()

            if annotated_img is not None:
                import cv2

                ok, buf = cv2.imencode(".jpg", annotated_img)
                if ok:
                    annotated_b64 = base64.b64encode(buf.tobytes()).decode("ascii")

            if result.boxes is not None:
                boxes = result.boxes
                has_masks = result.masks is not None
                for i in range(len(boxes)):
                    box = boxes.xyxy[i].cpu().numpy()
                    x1, y1, x2, y2 = (
                        float(box[0]),
                        float(box[1]),
                        float(box[2]),
                        float(box[3]),
                    )
                    confidence = float(boxes.conf[i].cpu().numpy())
                    class_id = int(boxes.cls[i].cpu().numpy())
                    class_name = (
                        class_names[class_id]
                        if class_id < len(class_names)
                        else f"Class {class_id}"
                    )
                    pred: Dict[str, Any] = {
                        "bbox": [x1, y1, x2 - x1, y2 - y1],
                        "confidence": confidence,
                        "class_id": class_id,
                        "class": class_name,
                    }
                    if has_masks and result.masks is not None:
                        try:
                            mask = result.masks.data[i].cpu().numpy()
                            orig_shape = result.orig_shape
                            if len(mask.shape) == 3:
                                mask = mask[0]
                            if mask.shape != orig_shape[:2]:
                                import cv2

                                mask = cv2.resize(
                                    mask.astype("float32"),
                                    (orig_shape[1], orig_shape[0]),
                                )
                            contours, _ = cv2.findContours(
                                (mask > 0.5).astype("uint8"),
                                cv2.RETR_EXTERNAL,
                                cv2.CHAIN_APPROX_SIMPLE,
                            )
                            if contours:
                                largest = max(contours, key=cv2.contourArea)
                                pred["segmentation"] = [
                                    largest.reshape(-1, 2).tolist()
                                ]
                        except Exception as mask_exc:
                            logger.debug("Mask export skipped: %s", mask_exc)
                    predictions.append(pred)

        return {
            "predictions": predictions,
            "annotated_jpeg_base64": annotated_b64,
            "error": None,
        }
    except Exception as exc:
        logger.error("yolo_test_inference task error: %s", exc, exc_info=True)
        return {
            "predictions": [],
            "annotated_jpeg_base64": None,
            "error": str(exc),
        }
