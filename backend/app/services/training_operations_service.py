"""Training operations (extracted from training router)."""
from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.ml.dataset import prepare_mmyolo_dataset, prepare_yolo_dataset
from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name
from app.ml.task_metadata import merge_task_metadata
from app.model_weights_presence import TRAINING_WEIGHTS_DOWNLOAD_NOTICE, is_training_base_weights_cached
from app.models import (
    Annotation,
    AnnotationClass,
    AnnotationFile,
    Dataset,
    Image,
    ImageCollection,
    Project,
    Task,
)
from app.services.training_checkpoints_service import (
    build_checkpoint_zip_response,
    list_training_checkpoints,
    resolve_checkpoint_path,
)
from app.services.training_dataset_config import reconstruct_dataset_configs_from_metadata
from app.services.training_schemas import (
    MMYOLOTrainingRequest,
    RTDETRTrainingRequest,
    YoloTrainingRequest,
)
from app.services.training_service import dispatch_training
from app.tasks.yolo_training_helpers import generate_safe_output_filename

logger = logging.getLogger(__name__)

USE_CELERY = os.environ.get("USE_CELERY", "true").lower() == "true"
celery_train_task = None
celery_rtdetr_task = None
celery_mmyolo_task = None

if USE_CELERY:
    try:
        from app.tasks.yolo_training import train_yolo_model as celery_train_task
        from app.tasks.rtdetr_training import train_rtdetr_model as celery_rtdetr_task
        from app.tasks.mmyolo_training import train_mmyolo_model as celery_mmyolo_task
        logger.info("Celery task queue enabled for training")
    except ImportError as e:
        logger.warning("Celery not available: %s. Set USE_CELERY=false to disable.", e)
        USE_CELERY = False

def _normalize_class_names(names: Any) -> List[str]:
    if isinstance(names, list):
        return [str(name) for name in names]
    if isinstance(names, dict):
        try:
            items = sorted(names.items(), key=lambda item: int(item[0]))
        except Exception:
            items = list(names.items())
        return [str(value) for _, value in items]
    return []


async def _read_import_classes(classes: Optional[UploadFile]) -> List[str]:
    if not classes:
        return []

    try:
        payload = json.loads((await classes.read()).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid classes.json: {exc}") from exc

    class_names: List[str] = []
    if isinstance(payload, list):
        class_names = [str(name) for name in payload]
    elif isinstance(payload, dict):
        if "class_names" in payload:
            class_names = _normalize_class_names(payload.get("class_names"))
        elif "names" in payload:
            class_names = _normalize_class_names(payload.get("names"))
        elif "classes" in payload:
            class_names = _normalize_class_names(payload.get("classes"))

    class_names = [name for name in class_names if name]
    if not class_names:
        raise HTTPException(
            status_code=400,
            detail=(
                'Could not find class names in classes.json. Expected '
                '{"class_names": [...]}, {"names": [...]}, or a JSON array.'
            ),
        )
    return class_names


def _extract_ultralytics_model_info(model_path: Path) -> Dict[str, Any]:
    """Extract class names and image size from Ultralytics YOLO model."""
    try:
        from app.tasks.training_common import get_ultralytics_yolo
        YOLO = get_ultralytics_yolo()

        model = YOLO(str(model_path))
        class_names = _normalize_class_names(getattr(model, "names", []))
        
        # Extract image size from model args
        imgsz = 640  # default fallback
        if hasattr(model, "args") and model.args:
            # model.args.imgsz could be int or list/tuple [h, w]
            model_imgsz = getattr(model.args, "imgsz", 640)
            if isinstance(model_imgsz, (list, tuple)) and len(model_imgsz) > 0:
                imgsz = int(model_imgsz[0])
            elif isinstance(model_imgsz, int):
                imgsz = model_imgsz
        
        return {
            "class_names": class_names,
            "image_size": imgsz,
        }
    except Exception as exc:
        logger.warning("Failed to extract model info from %s: %s", model_path, exc)
        return {
            "class_names": [],
            "image_size": 640,
        }


def _extract_ultralytics_class_names(model_path: Path) -> List[str]:
    """Backward compatibility wrapper - extract only class names from YOLO model."""
    info = _extract_ultralytics_model_info(model_path)
    return info.get("class_names", [])


def _sanitize_uploaded_filename(filename: Optional[str], expected_suffix: str) -> str:
    candidate = Path(filename or f"imported_model{expected_suffix}").name
    candidate = re.sub(r'[^A-Za-z0-9._-]', '_', candidate).strip('._')
    if not candidate:
        candidate = f"imported_model{expected_suffix}"
    if Path(candidate).suffix.lower() != expected_suffix:
        candidate = f"{Path(candidate).stem}{expected_suffix}"
    return candidate


async def import_model(
    name: str = Form(...),
    project_id: int = Form(...),
    model_format: str = Form(...),
    model_file: Optional[UploadFile] = File(None),
    pt: Optional[UploadFile] = File(None),
    onnx: Optional[UploadFile] = File(None),
    classes: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
):
    model_name = name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="Model name is required")

    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    fmt = model_format.strip().lower()
    if fmt not in {"pt", "onnx"}:
        raise HTTPException(status_code=400, detail="model_format must be 'pt' or 'onnx'")

    upload = model_file or (pt if fmt == "pt" else onnx)
    if not upload:
        raise HTTPException(status_code=400, detail="Model file is required")

    expected_suffix = f".{fmt}"
    original_filename = upload.filename or f"imported_model{expected_suffix}"
    if Path(original_filename).suffix.lower() != expected_suffix:
        raise HTTPException(status_code=400, detail=f"Expected a {expected_suffix} file")

    task = Task(
        name=model_name,
        description=f"Imported {fmt.upper()} model",
        task_type="training",
        status="pending",
        project_id=project_id,
        progress=0,
        started_at=datetime.utcnow(),
        task_metadata={"stage": "importing_model", "model_format": fmt},
    )
    db.add(task)
    db.flush()

    task_root = Path("projects") / str(project_id) / "training" / f"task_{task.id}"
    results_dir = task_root / "training"
    weights_dir = results_dir / "weights"
    imports_dir = task_root / "imports"
    weights_dir.mkdir(parents=True, exist_ok=True)
    imports_dir.mkdir(parents=True, exist_ok=True)

    model_filename = _sanitize_uploaded_filename(original_filename, expected_suffix)
    model_path = (weights_dir / model_filename) if fmt == "pt" else (imports_dir / model_filename)

    try:
        with model_path.open("wb") as target:
            shutil.copyfileobj(upload.file, target)

        class_names = await _read_import_classes(classes)
        image_size = 640  # default
        
        if fmt == "onnx":
            if not class_names:
                raise HTTPException(status_code=400, detail="classes.json is required for ONNX model imports")
            classes_path = Path(str(model_path) + ".classes.json")
            with classes_path.open("w", encoding="utf-8") as classes_file:
                json.dump({"class_names": class_names}, classes_file, indent=2)
            # Try to extract image size from ONNX model input shape
            try:
                import onnx
                onnx_model = onnx.load(str(model_path))
                if onnx_model.graph.input:
                    input_tensor = onnx_model.graph.input[0]
                    if input_tensor.type.tensor_type.shape.dim:
                        # ONNX typically has shape [batch, channels, height, width] or [batch, height, width, channels]
                        dims = [d.dim_value for d in input_tensor.type.tensor_type.shape.dim if d.dim_value > 0]
                        if len(dims) >= 3:
                            # Try to find the image dimension (usually the largest non-batch dimension)
                            spatial_dims = dims[1:]  # Skip batch dimension
                            image_size = int(spatial_dims[0]) if spatial_dims else 640
            except Exception as e:
                logger.debug("Could not extract image size from ONNX model: %s", e)
                image_size = 640
        else:  # fmt == "pt"
            if not class_names:
                model_info = _extract_ultralytics_model_info(model_path)
                class_names = model_info.get("class_names", [])
                image_size = model_info.get("image_size", 640)
            else:
                # If class names were provided but we still need image size, extract just that
                model_info = _extract_ultralytics_model_info(model_path)
                image_size = model_info.get("image_size", 640)

        metadata: Dict[str, Any] = {
            "source": "imported_model",
            "imported_model": True,
            "imported_at": datetime.utcnow().isoformat(),
            "model_format": fmt,
            "model_type": model_filename,
            "model_config": {"model": model_filename},
            "results_dir": str(results_dir),
            "class_names": class_names,
            "num_classes": len(class_names),
            "image_size": image_size,
            "original_model_file": original_filename,
        }
        if fmt == "pt":
            metadata["best_model"] = str(model_path)
        else:
            metadata["onnx_file"] = str(model_path)

        task.status = "completed"
        task.progress = 100
        task.completed_at = datetime.utcnow()
        task.task_metadata = metadata

        db.commit()
        db.refresh(task)

        return {
            "success": True,
            "message": "Model imported successfully",
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "task_type": task.task_type,
                "task_metadata": task.task_metadata,
            },
        }
    except HTTPException:
        db.rollback()
        shutil.rmtree(task_root, ignore_errors=True)
        raise
    except Exception as exc:
        db.rollback()
        shutil.rmtree(task_root, ignore_errors=True)
        logger.exception("Failed to import model for project %s", project_id)
        raise HTTPException(status_code=500, detail=f"Failed to import model: {exc}") from exc


# prepare_yolo_dataset -> app.ml.dataset.formats.yolo


async def start_yolo_training(
    request: YoloTrainingRequest,
    db: Session = Depends(get_db),
):
    """
    Start YOLO model training using Celery task queue.
    """
    try:
        # Validate datasets exist
        for config in request.dataset_configs:
            dataset = db.query(Dataset).filter(Dataset.id == config['dataset_id']).first()
            if not dataset:
                raise HTTPException(status_code=404, detail=f"Dataset {config['dataset_id']} not found")
            
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == config['annotation_file_id']
            ).first()
            if not ann_file:
                raise HTTPException(
                    status_code=404,
                    detail=f"Annotation file {config['annotation_file_id']} not found"
                )
        
        # Create task
        task_name = request.task_name or f"YOLO Training - {request.model_type}"
        
        # Prepare dataset configs with names for metadata
        dataset_configs_with_names = []
        for config in request.dataset_configs:
            dataset = db.query(Dataset).filter(Dataset.id == config['dataset_id']).first()
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == config['annotation_file_id']
            ).first()
            
            dataset_configs_with_names.append({
                'dataset_id': config['dataset_id'],
                'dataset_name': dataset.name if dataset else None,
                'annotation_file_id': config['annotation_file_id'],
                'annotation_file_name': ann_file.name if ann_file else None,
                'image_collection': config.get('image_collection'),
                'split': config.get('split', {'train': 80, 'val': 20, 'test': 0})
            })
        
        task = Task(
            name=task_name,
            description=f"Training YOLO model with {len(request.dataset_configs)} dataset(s)",
            task_type="yolo_training",
            status="pending",
            project_id=request.project_id,
            progress=0,
            task_metadata={
                "framework_id": "ultralytics.yolo",
                "model_type": request.model_type,
                "epochs": request.epochs,
                "batch_size": request.batch_size,
                "image_size": request.image_size,
                "dataset_count": len(request.dataset_configs),
                "dataset_ids": [config['dataset_id'] for config in request.dataset_configs],
                "dataset_configs": dataset_configs_with_names,
                "training_params": {
                    "batch_size": request.batch_size,
                    "epochs": request.epochs,
                    "image_size": request.image_size,
                    "imgsz": request.image_size,
                    "device": request.device,
                    "optimizer": request.optimizer,
                    "lr0": request.learning_rate,
                    "momentum": request.momentum,
                    "weight_decay": request.weight_decay,
                    "save_period": request.save_period,
                    "patience": request.patience
                },
                "model_config": {
                    "model": request.model_type,
                    "task": "detect",
                    "augmentations": request.augmentations or {}
                },
                "remove_images_without_annotations": request.remove_images_without_annotations
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Prepare training config
        training_config = {
            'project_id': request.project_id,
            'dataset_configs': request.dataset_configs,
            'model_type': request.model_type,
            'epochs': request.epochs,
            'batch_size': request.batch_size,
            'image_size': request.image_size,
            'device': request.device,
            'patience': request.patience,
            'optimizer': request.optimizer,
            'learning_rate': request.learning_rate,
            'momentum': request.momentum,
            'weight_decay': request.weight_decay,
            'save_period': request.save_period,
            'augmentations': request.augmentations or {},
            'remove_images_without_annotations': request.remove_images_without_annotations,
            'use_wandb': request.use_wandb,
            'wandb_project': request.wandb_project,
            'wandb_entity': request.wandb_entity,
        }
        
        logger.info(f"Prepared training config for task {task.id}: keys={list(training_config.keys())}")
        logger.info(f"Training config: model_type={training_config['model_type']}, epochs={training_config['epochs']}, remove_images={training_config.get('remove_images_without_annotations')}")
        
        dispatch_training(
            db,
            task,
            training_config,
            framework_id="ultralytics.yolo",
            celery_task=celery_train_task,
            use_celery=USE_CELERY,
            feature_name="YOLO training",
        )

        tw_cached = is_training_base_weights_cached(request.model_type)

        return {
            "success": True,
            "task_id": task.id,
            "message": "YOLO training started",
            "weights_download_expected": not tw_cached,
            "weights_download_notice": None if tw_cached else TRAINING_WEIGHTS_DOWNLOAD_NOTICE,
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "progress": task.progress
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting YOLO training: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def rerun_training(
    task_id: int,
    db: Session = Depends(get_db),
):
    """
    Rerun a training task with the same settings.
    Creates a new task with identical configuration and starts training.
    """
    try:
        # Get the original task
        original_task = db.query(Task).filter(Task.id == task_id).first()
        if not original_task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        
        if original_task.task_type not in ['yolo_training', 'training', 'mmyolo_training']:
            raise HTTPException(
                status_code=400,
                detail=f"Task type {original_task.task_type} is not supported for rerun"
            )
        
        # Extract configuration from task metadata
        metadata = original_task.task_metadata or {}
        training_params = metadata.get('training_params', {})
        dataset_configs = metadata.get('dataset_configs', [])
        
        # Log full metadata structure for debugging
        logger.info(f"Rerun task {task_id}: Full metadata keys = {list(metadata.keys())}")
        logger.info(f"Rerun task {task_id}: dataset_configs type = {type(dataset_configs)}, count = {len(dataset_configs) if dataset_configs else 0}")
        logger.info(f"Rerun task {task_id}: dataset_ids = {metadata.get('dataset_ids', [])}")
        if dataset_configs:
            logger.info(f"Rerun task {task_id}: First dataset_config sample = {dataset_configs[0] if len(dataset_configs) > 0 else 'N/A'}")
        
        # Reconstruct dataset_configs (remove names, keep only IDs and config)
        reconstructed_configs = reconstruct_dataset_configs_from_metadata(dataset_configs)
        if dataset_configs and isinstance(dataset_configs, list) and len(dataset_configs) > 0:
            logger.info(f"Processing {len(dataset_configs)} dataset configs from metadata")
            for idx, normalized in enumerate(reconstructed_configs):
                logger.info(
                    f"Reconstructed config {idx}: dataset_id={normalized['dataset_id']}, "
                    f"annotation_file_id={normalized['annotation_file_id']}"
                )
            skipped = len(dataset_configs) - len(reconstructed_configs)
            if skipped:
                logger.warning(
                    f"Rerun task {task_id}: skipped {skipped} invalid dataset config(s)"
                )
        
        # If dataset_configs is empty or invalid, try to reconstruct from dataset_ids
        if not reconstructed_configs:
            dataset_ids = metadata.get('dataset_ids', [])
            model_type = metadata.get('model_type', '')
            is_segmentation = '-seg' in model_type.lower()
            
            if dataset_ids:
                # Try to find annotation files for these datasets
                for dataset_id in dataset_ids:
                    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
                    if not dataset:
                        continue
                    
                    # Get annotation files for this dataset
                    ann_files = db.query(AnnotationFile).filter(
                        AnnotationFile.dataset_id == dataset_id
                    ).all()
                    
                    if ann_files:
                        # Try to find an annotation file matching the model type
                        selected_ann_file = None
                        
                        for ann_file in ann_files:
                            has_segmentation = db.query(Annotation).filter(
                                Annotation.annotation_file_id == ann_file.id,
                                Annotation.segmentation.isnot(None),
                            ).first() is not None
                            has_bbox = db.query(Annotation).filter(
                                Annotation.annotation_file_id == ann_file.id,
                                or_(
                                    Annotation.bbox.isnot(None),
                                    Annotation.bbox_x.isnot(None),
                                ),
                            ).first() is not None

                            if is_segmentation and has_segmentation:
                                selected_ann_file = ann_file
                                logger.info(
                                    f"Found matching segmentation annotation file {ann_file.id} for dataset {dataset_id}"
                                )
                                break
                            if not is_segmentation and has_bbox:
                                selected_ann_file = ann_file
                                logger.info(
                                    f"Found matching detection annotation file {ann_file.id} for dataset {dataset_id}"
                                )
                                break
                        
                        # Fallback to first if no match found
                        if not selected_ann_file:
                            selected_ann_file = ann_files[0]
                            logger.warning(
                                f"No matching annotation type found, using first annotation file {selected_ann_file.id} for dataset {dataset_id}"
                            )
                        
                        reconstructed_configs.append({
                            'dataset_id': dataset_id,
                            'annotation_file_id': selected_ann_file.id,
                            'image_collection': None,
                            'split': {'train': 80, 'val': 20, 'test': 0}
                        })
                        logger.warning(
                            f"Reconstructed dataset config for task {task_id}: "
                            f"using annotation file {selected_ann_file.id} ({selected_ann_file.name}) for dataset {dataset_id}"
                        )
        
        if not reconstructed_configs:
            # Log the metadata structure for debugging
            logger.error(f"Task {task_id} metadata structure: {json.dumps(metadata, indent=2, default=str)}")
            logger.error(f"Task {task_id} task_type: {original_task.task_type}")
            logger.error(f"Task {task_id} project_id: {original_task.project_id}")
            
            # Try one more fallback: check if we can get dataset_ids from the project
            if original_task.project_id:
                # Try to find any datasets in the project and use the first annotation file
                project_datasets = db.query(Dataset).filter(Dataset.project_id == original_task.project_id).all()
                if project_datasets:
                    logger.warning(
                        f"Attempting fallback: scanning project {original_task.project_id} datasets for usable annotations"
                    )
                    for dataset in project_datasets:
                        ann_file = db.query(AnnotationFile).filter(
                            AnnotationFile.dataset_id == dataset.id
                        ).first()
                        if not ann_file:
                            logger.info(f"Fallback skip: dataset {dataset.id} has no annotation files")
                            continue

                        reconstructed_configs.append({
                            'dataset_id': dataset.id,
                            'annotation_file_id': ann_file.id,
                            'image_collection': None,
                            'split': {'train': 80, 'val': 20, 'test': 0}
                        })
                        logger.warning(
                            f"Fallback: Using dataset {dataset.id} with annotation file {ann_file.id}"
                        )
                        break
            
            if not reconstructed_configs:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Cannot rerun task {task_id}: dataset configuration not found in task metadata. "
                        f"The task may have been created with an older version of the system or the metadata was corrupted. "
                        f"Please check the task metadata or create a new training task manually. "
                        f"Metadata keys available: {list(metadata.keys())}"
                    )
                )
        
        # Determine model type/family
        model_type_raw = metadata.get('model_type') or metadata.get('model_config', {}).get('model') or 'yolo11n-seg.pt'
        model_variant = metadata.get('model_variant')
        from app.ml.dispatch import get_model_backend

        try:
            is_mmyolo = get_model_backend(original_task).runtime_profile == "mmyolo"
        except KeyError:
            is_mmyolo = original_task.task_type == 'mmyolo_training' or bool(metadata.get('config_id')) or bool(metadata.get('arch'))
        is_rtdetr = bool(model_variant) or str(model_type_raw).lower().startswith('rtdetr')

        # MMYOLO rerun path
        if is_mmyolo:
            arch = metadata.get('arch') or training_params.get('arch', 'rtmdet')
            size = metadata.get('size') or training_params.get('size', 's')
            mmyolo_task = metadata.get('mmyolo_task') or training_params.get('task', 'detect')

            try:
                config_id = mmyolo_config_name(arch, size)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc))

            request_data = {
                'project_id': original_task.project_id,
                'dataset_configs': reconstructed_configs,
                'arch': arch,
                'size': size,
                'task': mmyolo_task,
                'epochs': training_params.get('epochs', metadata.get('epochs', 300)),
                'batch_size': training_params.get('batch_size', 16),
                'image_size': training_params.get('image_size', training_params.get('imgsz', 640)),
                'device': training_params.get('device', '0'),
                'task_name': f"{original_task.name} (Rerun)",
                'optimizer': training_params.get('optimizer', 'AdamW'),
                'learning_rate': training_params.get('learning_rate', 0.004),
                'weight_decay': training_params.get('weight_decay', 0.05),
                'save_period': training_params.get('save_period', -1),
                'remove_images_without_annotations': metadata.get('remove_images_without_annotations', True),
                'dji_patch_path': metadata.get('dji_patch_path'),
                'use_wandb': metadata.get('use_wandb', False),
                'wandb_project': metadata.get('wandb_project'),
                'wandb_entity': metadata.get('wandb_entity'),
            }

            request = MMYOLOTrainingRequest(**request_data)

            for cfg in request.dataset_configs:
                dataset = db.query(Dataset).filter(Dataset.id == cfg['dataset_id']).first()
                if not dataset:
                    raise HTTPException(status_code=404, detail=f"Dataset {cfg['dataset_id']} not found")
                ann_file = db.query(AnnotationFile).filter(
                    AnnotationFile.id == cfg['annotation_file_id']
                ).first()
                if not ann_file:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Annotation file {cfg['annotation_file_id']} not found"
                    )

            if request.dji_patch_path:
                patch_path = Path(request.dji_patch_path)
                if not patch_path.exists() or not patch_path.is_file():
                    raise HTTPException(status_code=400, detail="Provided DJI patch file does not exist.")
                if patch_path.suffix.lower() != ".patch":
                    raise HTTPException(status_code=400, detail="DJI patch must be a .patch file.")

            task_name = (
                request.task_name
                or f"MMYOLO {request.arch.upper()} ({request.size.upper()}) — "
                   f"{datetime.utcnow().strftime('%Y-%m-%d %H:%M')}"
            )

            task = Task(
                name=task_name,
                description=(
                    f"MMYOLO training: {request.arch} · {request.size} · {request.task} "
                    f"on {len(request.dataset_configs)} dataset(s) (Rerun of task {task_id})"
                ),
                task_type="mmyolo_training",
                status="pending",
                project_id=request.project_id,
                progress=0,
                task_metadata={
                    "model_type": f"{request.arch}_{request.size}",
                    "arch": request.arch,
                    "size": request.size,
                    "mmyolo_task": request.task,
                    "config_id": config_id,
                    "epochs": request.epochs,
                    "batch_size": request.batch_size,
                    "image_size": request.image_size,
                    "dataset_count": len(request.dataset_configs),
                    "dataset_ids": [c["dataset_id"] for c in request.dataset_configs],
                    "dataset_configs": request.dataset_configs,
                    "training_params": {
                        "epochs": request.epochs,
                        "batch_size": request.batch_size,
                        "image_size": request.image_size,
                        "device": request.device,
                        "optimizer": request.optimizer,
                        "learning_rate": request.learning_rate,
                        "weight_decay": request.weight_decay,
                        "save_period": request.save_period,
                        "arch": request.arch,
                        "size": request.size,
                        "task": request.task,
                    },
                    "remove_images_without_annotations": request.remove_images_without_annotations,
                    "dji_patch_path": request.dji_patch_path,
                    "use_wandb": request.use_wandb,
                    "wandb_project": request.wandb_project,
                    "wandb_entity": request.wandb_entity,
                    "rerun_of_task_id": task_id,
                },
            )
            db.add(task)
            db.commit()
            db.refresh(task)

            training_config = {
                "project_id": request.project_id,
                "dataset_configs": request.dataset_configs,
                "arch": request.arch,
                "size": request.size,
                "task": request.task,
                "config_id": config_id,
                "epochs": request.epochs,
                "batch_size": request.batch_size,
                "image_size": request.image_size,
                "device": request.device,
                "optimizer": request.optimizer,
                "learning_rate": request.learning_rate,
                "weight_decay": request.weight_decay,
                "save_period": request.save_period,
                "remove_images_without_annotations": request.remove_images_without_annotations,
                "dji_patch_path": request.dji_patch_path,
                "dji_use_widen_factor_025": request.dji_use_widen_factor_025,
                "use_wandb": request.use_wandb,
                "wandb_project": request.wandb_project,
                "wandb_entity": request.wandb_entity,
            }

            if USE_CELERY and celery_mmyolo_task is not None:
                from app.ml.celery_dispatch import enqueue_training_task

                celery_task = enqueue_training_task(
                    celery_mmyolo_task, task.id, training_config, "mmyolo"
                )
                logger.info(
                    f"Queued rerun MMYOLO training task {task.id} in Celery (celery_id: {celery_task.id}, rerun of {task_id})"
                )
                task.task_metadata = {**task.task_metadata, "celery_task_id": celery_task.id}
                db.commit()
            else:
                logger.warning("Celery not available; MMYOLO rerun cannot run without Celery worker.")
                task.status = "failed"
                task.error_message = "Celery worker not available — cannot start MMYOLO rerun."
                db.commit()
                raise HTTPException(
                    status_code=503,
                    detail="Celery worker is required for MMYOLO rerun but is not available.",
                )

            return {
                "success": True,
                "task_id": task.id,
                "original_task_id": task_id,
                "message": f"MMYOLO rerun started ({request.arch} · {request.size})",
                "task": {
                    "id": task.id,
                    "name": task.name,
                    "status": task.status,
                    "progress": task.progress,
                },
            }

        # RT-DETR rerun path (uses RT-DETR task queue and metadata shape)
        if is_rtdetr:
            rtdetr_model_type = model_variant or model_type_raw

            request_data = {
                'project_id': original_task.project_id,
                'dataset_configs': reconstructed_configs,
                'model_type': rtdetr_model_type,
                'epochs': training_params.get('epochs', metadata.get('epochs', 100)),
                'batch_size': training_params.get('batch_size', 16),
                'image_size': training_params.get('image_size', training_params.get('imgsz', 640)),
                'device': training_params.get('device', '0'),
                'task_name': f"{original_task.name} (Rerun)",
                'patience': training_params.get('patience', 50),
                'optimizer': training_params.get('optimizer', 'AdamW'),
                'learning_rate': training_params.get('learning_rate', 0.0001),
                'weight_decay': training_params.get('weight_decay', 0.0001),
                'save_period': training_params.get('save_period', -1),
                'use_wandb': metadata.get('use_wandb', False),
                'wandb_project': metadata.get('wandb_project'),
                'wandb_entity': metadata.get('wandb_entity'),
            }

            request = RTDETRTrainingRequest(**request_data)

            for config in request.dataset_configs:
                dataset = db.query(Dataset).filter(Dataset.id == config['dataset_id']).first()
                if not dataset:
                    raise HTTPException(status_code=404, detail=f"Dataset {config['dataset_id']} not found")

                ann_file = db.query(AnnotationFile).filter(
                    AnnotationFile.id == config['annotation_file_id']
                ).first()
                if not ann_file:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Annotation file {config['annotation_file_id']} not found"
                    )

            task = Task(
                project_id=request.project_id,
                name=request.task_name or f"RT-DETR Training - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} (Rerun)",
                task_type="training",
                status="queued",
                progress=0,
                task_metadata={
                    "model_type": "rtdetr",
                    "model_variant": request.model_type,
                    "training_params": request.dict(exclude={'project_id', 'dataset_configs', 'task_name'}),
                    "dataset_configs": request.dataset_configs,
                    "rerun_of_task_id": task_id,
                }
            )
            db.add(task)
            db.commit()
            db.refresh(task)

            output_dir = Path(f"projects/{request.project_id}/training/task_{task.id}")
            output_dir.mkdir(parents=True, exist_ok=True)

            dataset_info = prepare_yolo_dataset(
                db=db,
                dataset_configs=request.dataset_configs,
                output_dir=output_dir,
                model_type=request.model_type,
                remove_images_without_annotations=True
            )

            # prepare_yolo_dataset writes data.yaml (including val→train fallback when needed).
            yaml_path = Path(dataset_info["yaml_path"])
            if not yaml_path.is_file():
                yaml_path = output_dir / "data.yaml"

            task.task_metadata = {
                **task.task_metadata,
                "output_dir": str(output_dir),
                "data_yaml": str(yaml_path),
                "num_classes": len(dataset_info['class_names']),
                "class_names": dataset_info['class_names'],
                "classes": dataset_info['class_names']
            }
            db.commit()
            db.refresh(task)

            training_config = {
                "task_id": task.id,
                "model_type": request.model_type,
                "data_yaml": str(yaml_path),
                "epochs": request.epochs,
                "batch_size": request.batch_size,
                "image_size": request.image_size,
                "device": request.device,
                "output_dir": str(output_dir),
                "patience": request.patience,
                "optimizer": request.optimizer,
                "learning_rate": request.learning_rate,
                "weight_decay": request.weight_decay,
                "use_wandb": request.use_wandb,
                "wandb_project": request.wandb_project,
                "wandb_entity": request.wandb_entity
            }

            if USE_CELERY and celery_rtdetr_task is not None:
                from app.ml.celery_dispatch import enqueue_training_task

                celery_task = enqueue_training_task(
                    celery_rtdetr_task, task.id, training_config, "ultralytics.rtdetr"
                )
                logger.info(f"Queued rerun RT-DETR training task {task.id} in Celery (task_id: {celery_task.id}, rerun of {task_id})")
                task.task_metadata = {
                    **task.task_metadata,
                    "celery_task_id": celery_task.id
                }
                db.commit()
            else:
                logger.warning("RT-DETR rerun requires Celery worker")
                raise HTTPException(status_code=500, detail="RT-DETR rerun requires Celery")

            return {
                "success": True,
                "task_id": task.id,
                "original_task_id": task_id,
                "message": "RT-DETR rerun started",
                "task": {
                    "id": task.id,
                    "name": task.name,
                    "status": task.status,
                    "progress": task.progress
                }
            }

        # Default YOLO rerun path
        model_type = model_type_raw
        orig_model_config = metadata.get("model_config") or {}
        model_task = orig_model_config.get("task")
        if not model_task:
            model_task = "segment" if "-seg" in str(model_type).lower() else "detect"

        # Reconstruct YoloTrainingRequest
        request_data = {
            'project_id': original_task.project_id,
            'dataset_configs': reconstructed_configs,
            'model_type': model_type,
            'epochs': training_params.get('epochs', metadata.get('epochs', 100)),
            'batch_size': training_params.get('batch_size', 16),
            'image_size': training_params.get('image_size', training_params.get('imgsz', 640)),
            'device': training_params.get('device', '0'),
            'task_name': f"{original_task.name} (Rerun)",
            'patience': training_params.get('patience', 50),
            'optimizer': training_params.get('optimizer', 'auto'),
            'learning_rate': training_params.get('lr0', training_params.get('learning_rate', 0.01)),
            'momentum': training_params.get('momentum', 0.937),
            'weight_decay': training_params.get('weight_decay', 0.0005),
            'save_period': training_params.get('save_period', -1),
            'augmentations': metadata.get('model_config', {}).get('augmentations'),
            'remove_images_without_annotations': metadata.get('remove_images_without_annotations', True),
            'use_wandb': metadata.get('use_wandb', False),
            'wandb_project': metadata.get('wandb_project'),
            'wandb_entity': metadata.get('wandb_entity'),
        }
        
        # Create YoloTrainingRequest
        request = YoloTrainingRequest(**request_data)
        
        # Start training using the existing endpoint logic
        # Validate datasets exist
        for config in request.dataset_configs:
            dataset = db.query(Dataset).filter(Dataset.id == config['dataset_id']).first()
            if not dataset:
                raise HTTPException(status_code=404, detail=f"Dataset {config['dataset_id']} not found")
            
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == config['annotation_file_id']
            ).first()
            if not ann_file:
                raise HTTPException(
                    status_code=404,
                    detail=f"Annotation file {config['annotation_file_id']} not found"
                )
        
        # Create new task
        task_name = request.task_name or f"YOLO Training - {request.model_type} (Rerun)"
        
        # Prepare dataset configs with names for metadata
        dataset_configs_with_names = []
        for config in request.dataset_configs:
            dataset = db.query(Dataset).filter(Dataset.id == config['dataset_id']).first()
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == config['annotation_file_id']
            ).first()
            
            dataset_configs_with_names.append({
                'dataset_id': config['dataset_id'],
                'dataset_name': dataset.name if dataset else None,
                'annotation_file_id': config['annotation_file_id'],
                'annotation_file_name': ann_file.name if ann_file else None,
                'image_collection': config.get('image_collection'),
                'split': config.get('split', {'train': 80, 'val': 20, 'test': 0})
            })
        
        task = Task(
            name=task_name,
            description=f"Training YOLO model with {len(request.dataset_configs)} dataset(s) (Rerun of task {task_id})",
            task_type="yolo_training",
            status="pending",
            project_id=request.project_id,
            progress=0,
            task_metadata={
                "framework_id": "ultralytics.yolo",
                "model_type": request.model_type,
                "epochs": request.epochs,
                "batch_size": request.batch_size,
                "image_size": request.image_size,
                "dataset_count": len(request.dataset_configs),
                "dataset_ids": [config['dataset_id'] for config in request.dataset_configs],
                "dataset_configs": dataset_configs_with_names,
                "training_params": {
                    "batch_size": request.batch_size,
                    "epochs": request.epochs,
                    "image_size": request.image_size,
                    "imgsz": request.image_size,
                    "device": request.device,
                    "optimizer": request.optimizer,
                    "lr0": request.learning_rate,
                    "momentum": request.momentum,
                    "weight_decay": request.weight_decay,
                    "save_period": request.save_period,
                    "patience": request.patience
                },
                "model_config": {
                    "model": request.model_type,
                    "task": model_task,
                    "augmentations": request.augmentations or {}
                },
                "remove_images_without_annotations": request.remove_images_without_annotations,
                "rerun_of_task_id": task_id
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Prepare training config
        training_config = {
            'project_id': request.project_id,
            'dataset_configs': request.dataset_configs,
            'model_type': request.model_type,
            'epochs': request.epochs,
            'batch_size': request.batch_size,
            'image_size': request.image_size,
            'device': request.device,
            'patience': request.patience,
            'optimizer': request.optimizer,
            'learning_rate': request.learning_rate,
            'momentum': request.momentum,
            'weight_decay': request.weight_decay,
            'save_period': request.save_period,
            'augmentations': request.augmentations or {},
            'remove_images_without_annotations': request.remove_images_without_annotations,
            'use_wandb': request.use_wandb,
            'wandb_project': request.wandb_project,
            'wandb_entity': request.wandb_entity,
        }
        
        dispatch_training(
            db,
            task,
            training_config,
            framework_id="ultralytics.yolo",
            celery_task=celery_train_task,
            use_celery=USE_CELERY,
            feature_name="YOLO training rerun",
        )

        return {
            "success": True,
            "task_id": task.id,
            "original_task_id": task_id,
            "message": "Training rerun started",
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "progress": task.progress
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error rerunning training task {task_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def get_training_status(task_id: int, db: Session = Depends(get_db)):
    """Get the status of a training task"""
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    return {
        "success": True,
        "task": {
            "id": task.id,
            "name": task.name,
            "status": task.status,
            "progress": task.progress,
            "created_at": task.created_at.isoformat() if task.created_at else None,
            "started_at": task.started_at.isoformat() if task.started_at else None,
            "completed_at": task.completed_at.isoformat() if task.completed_at else None,
            "error_message": task.error_message,
            "metadata": task.task_metadata
        }
    }


async def start_rtdetr_training(
    request: RTDETRTrainingRequest,
    db: Session = Depends(get_db),
):
    """
    Start RT-DETR model training using Celery task queue.
    """
    try:
        # Create task record first to get task_id
        task_name = request.task_name or f"RT-DETR Training - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        task = Task(
            project_id=request.project_id,
            name=task_name,
            task_type="training",
            status="queued",
            progress=0,
            task_metadata={
                "framework_id": "ultralytics.rtdetr",
                "model_type": "rtdetr",
                "model_variant": request.model_type,
                "training_params": request.dict(exclude={'project_id', 'dataset_configs', 'task_name'}),
                "dataset_configs": request.dataset_configs,
            }
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Create output directory using task_id (same as YOLO)
        output_dir = Path(f"projects/{request.project_id}/training/task_{task.id}")
        output_dir.mkdir(parents=True, exist_ok=True)
        
        dataset_info = prepare_yolo_dataset(  # RT-DETR uses YOLO format
            db=db,
            dataset_configs=request.dataset_configs,
            output_dir=output_dir,
            model_type=request.model_type,
            remove_images_without_annotations=True  # RT-DETR should also remove images without annotations
        )

        yaml_path = Path(dataset_info["yaml_path"])
        if not yaml_path.is_file():
            yaml_path = output_dir / "data.yaml"
        # Update task with dataset info
        task.task_metadata = {
            **task.task_metadata,
            "output_dir": str(output_dir),
            "data_yaml": str(yaml_path),
            "num_classes": len(dataset_info['class_names']),
            "class_names": dataset_info['class_names'],
            "classes": dataset_info['class_names']
        }
        db.commit()
        db.refresh(task)
        
        training_config = {
            "task_id": task.id,
            "model_type": request.model_type,
            "data_yaml": str(yaml_path),
            "epochs": request.epochs,
            "batch_size": request.batch_size,
            "image_size": request.image_size,
            "device": request.device,
            "output_dir": str(output_dir),
            "patience": request.patience,
            "optimizer": request.optimizer,
            "learning_rate": request.learning_rate,
            "weight_decay": request.weight_decay,
            "use_wandb": request.use_wandb,
            "wandb_project": request.wandb_project,
            "wandb_entity": request.wandb_entity
        }
        
        dispatch_training(
            db,
            task,
            training_config,
            framework_id="ultralytics.rtdetr",
            celery_task=celery_rtdetr_task,
            use_celery=USE_CELERY,
            feature_name="RT-DETR training",
        )

        rtd_cached = is_training_base_weights_cached(request.model_type)

        return {
            "success": True,
            "task_id": task.id,
            "message": "RT-DETR training started",
            "weights_download_expected": not rtd_cached,
            "weights_download_notice": None if rtd_cached else TRAINING_WEIGHTS_DOWNLOAD_NOTICE,
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "progress": task.progress
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error starting RT-DETR training: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def list_checkpoints(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Training task not found")
    return list_training_checkpoints(task)


async def download_checkpoint(
    task_id: int,
    checkpoint: str = Query(..., description="Checkpoint name (e.g., 'best', 'last', 'epoch10.pt')"),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Training task not found")
    model_path = resolve_checkpoint_path(task, checkpoint)
    return build_checkpoint_zip_response(task, checkpoint, model_path)


async def test_training_model_inference(
    task_id: int,
    image: UploadFile = File(...),
    checkpoint: str = Query("best", description="Checkpoint to use (best, last, or specific checkpoint)"),
    db: Session = Depends(get_db)
):
    """
    Test YOLO .pt model inference on an uploaded image.
    Returns predictions with bounding boxes and confidence scores.
    """
    try:
        # Verify the training task exists
        task = db.query(Task).filter(Task.id == task_id).first()
        
        if not task:
            raise HTTPException(status_code=404, detail="Training task not found")
        
        if task.task_type not in ['yolo_training', 'training', 'mmyolo_training']:
            raise HTTPException(status_code=400, detail="Task is not a training task")
        
        if task.status != 'completed':
            raise HTTPException(
                status_code=400,
                detail=f"Training task is not completed. Current status: {task.status}"
            )
        
        # Get model path based on checkpoint
        task_metadata = task.task_metadata or {}
        from app.ml.dispatch import get_model_backend

        backend = get_model_backend(task)
        is_mmyolo = backend.runtime_profile == "mmyolo"

        # --- MMYOLO: use the dedicated resolver (handles .pth naming conventions) ---
        if is_mmyolo:
            from app.tasks.mmyolo_evaluation import resolve_mmyolo_checkpoint
            model_path = resolve_mmyolo_checkpoint(task_metadata, checkpoint)
            if not model_path or not Path(model_path).exists():
                raise HTTPException(
                    status_code=404,
                    detail=f"Model checkpoint '{checkpoint}' not found for task {task_id}. "
                           f"Looked in results_dir='{task_metadata.get('results_dir')}'. "
                           f"best_model='{task_metadata.get('best_model')}'"
                )
        else:
            model_path = None
            if checkpoint == "best":
                model_path = task_metadata.get('best_model')
            elif checkpoint == "last":
                model_path = task_metadata.get('last_model')
            elif task_metadata.get('results_dir'):
                weights_dir = Path(task_metadata['results_dir']) / "weights"
                if weights_dir.exists():
                    potential_path = weights_dir / checkpoint
                    if potential_path.exists() and potential_path.suffix in {'.pt', '.pth'}:
                        model_path = str(potential_path)
                    else:
                        for ext in ('.pt', '.pth'):
                            candidate = weights_dir / f"{checkpoint}{ext}"
                            if candidate.exists():
                                model_path = str(candidate)
                                break

            if not model_path or not Path(model_path).exists():
                raise HTTPException(
                    status_code=404,
                    detail=f"Model checkpoint '{checkpoint}' not found for task {task_id}"
                )
        
        # Get class names from task metadata
        class_names = task_metadata.get('class_names', [])

        # ── MMYOLO inference — runs directly in the backend via /opt/mmyolo-venv ──
        # The backend image now includes a CPU MMYOLO venv so inference is instant
        # and never blocks behind a training job running in celery_worker.
        if is_mmyolo:
            from app.tasks.mmyolo_evaluation import (
                MMYOLO_INFERENCE_SCRIPT,
                resolve_mmyolo_config_path,
                _build_mmyolo_eval_env,
            )
            from app.tasks.training_common import MMYOLO_PYTHON

            config_path = resolve_mmyolo_config_path(task_id, task_metadata)
            if not config_path:
                raise HTTPException(
                    status_code=400,
                    detail="MMYOLO config file not found. Expected at "
                           f"projects/<project_id>/training/task_{task_id}/mmyolo_config.py"
                )
            if not Path(MMYOLO_PYTHON).exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"MMYOLO Python environment not found at {MMYOLO_PYTHON}. "
                           "Rebuild the backend image to include the MMYOLO venv."
                )

            content = await image.read()
            with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp_img:
                tmp_img_path = tmp_img.name
                tmp_img.write(content)

            try:
                output_dir = Path(tempfile.gettempdir()) / f"mmyolo_inf_{uuid.uuid4().hex[:8]}"
                output_dir.mkdir(exist_ok=True)
                input_json = output_dir / "input.json"
                output_json_path = output_dir / "output.json"

                input_json.write_text(
                    json.dumps([{"image_id": 0, "path": tmp_img_path}]), encoding="utf-8"
                )
                env = _build_mmyolo_eval_env(
                    device="cpu",  # backend container is CPU-only
                    dji_repo_dir=task_metadata.get("dji_repo_dir"),
                )
                cmd = [
                    MMYOLO_PYTHON,
                    str(MMYOLO_INFERENCE_SCRIPT),
                    "--config", config_path,
                    "--checkpoint", model_path,
                    "--input-json", str(input_json),
                    "--output-json", str(output_json_path),
                    "--num-classes", str(len(class_names)),
                    "--conf", "0.25",
                    "--device", "cpu",
                ]
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, env=env, cwd=str(Path.cwd())
                )
                if proc.returncode != 0:
                    err = (proc.stderr or proc.stdout or "").strip()[-1500:]
                    raise HTTPException(status_code=500, detail=f"MMYOLO inference failed: {err}")

                preds_raw = []
                if output_json_path.exists():
                    preds_raw = json.loads(output_json_path.read_text(encoding="utf-8"))

                predictions = []
                for p in preds_raw:
                    # mmyolo_eval_inference.py emits COCO xywh in "bbox" and corners in "bbox_xyxy"
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
                        class_names[class_id] if class_id < len(class_names)
                        else f"class_{class_id}"
                    )
                    predictions.append({
                        "bbox": bbox_xywh,
                        "confidence": float(p.get("confidence", p.get("conf", 0))),
                        "class_id": class_id,
                        "class": class_name,
                        "segmentation": p.get("segmentation", []),
                    })

                static_dir = Path("static/inference_results")
                static_dir.mkdir(parents=True, exist_ok=True)
                annotated_filename = f"annotated_{task_id}_{uuid.uuid4().hex[:8]}.jpg"
                import shutil as _shutil
                _shutil.copy2(tmp_img_path, str(static_dir / annotated_filename))

                # Match Ultralytics test-inference shape: { success, result: { predictions, image_url } }
                return JSONResponse({
                    "success": True,
                    "result": {
                        "predictions": predictions,
                        "image_url": f"/static/inference_results/{annotated_filename}",
                    },
                    "model_path": model_path,
                })
            finally:
                os.unlink(tmp_img_path)
                import shutil as _shutil
                _shutil.rmtree(str(output_dir), ignore_errors=True)

        # ── Ultralytics YOLO inference (celery_worker Ultralytics runtime) ──
        # Use shared data volume so celery_worker can read the upload (not /tmp).
        shared_upload_dir = Path("data/inference_uploads")
        shared_upload_dir.mkdir(parents=True, exist_ok=True)
        tmp_image_path = str(shared_upload_dir / f"test_inf_{task_id}_{uuid.uuid4().hex[:8]}.jpg")
        content = await image.read()
        Path(tmp_image_path).write_bytes(content)

        try:
            from app.ml.yolo_test_inference_dispatch import run_yolo_test_inference_via_celery

            return run_yolo_test_inference_via_celery(
                task_id=task_id,
                tmp_image_path=tmp_image_path,
                model_path=model_path,
                class_names=class_names,
            )
        except HTTPException:
            raise
        except Exception as e:
            if os.path.exists(tmp_image_path):
                os.unlink(tmp_image_path)
            logger.error(f"Error running inference: {str(e)}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in test inference: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")


# ── MMYOLO endpoint ──────────────────────────────────────────────────────────

async def upload_mmyolo_dji_patch(file: UploadFile = File(...)):
    """Upload DJI AI Inside patch file used to modify MMYOLO before training."""
    try:
        logger.info(f"Received DJI patch upload request: filename={file.filename}, content_type={file.content_type}")
        
        filename = file.filename or ""
        if not filename.lower().endswith(".patch"):
            logger.warning(f"Invalid file extension for DJI patch: {filename}")
            raise HTTPException(status_code=400, detail="Only .patch files are supported.")

        patch_dir = Path(os.environ.get("DJI_PATCH_STORAGE_DIR", "/app/data/dji_patches"))
        logger.info(f"Using patch storage directory: {patch_dir}")
        
        try:
            patch_dir.mkdir(parents=True, exist_ok=True)
        except Exception as dir_error:
            logger.error(f"Failed to create patch directory {patch_dir}: {dir_error}")
            raise HTTPException(status_code=500, detail=f"Failed to create storage directory: {str(dir_error)}")

        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(filename).name)
        stored_name = f"{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{safe_name}"
        stored_path = patch_dir / stored_name
        
        logger.info(f"Saving patch to: {stored_path}")

        try:
            with open(stored_path, "wb") as out:
                content = await file.read()
                out.write(content)
                logger.info(f"Successfully wrote {len(content)} bytes to {stored_path}")
        except Exception as write_error:
            logger.error(f"Failed to write patch file: {write_error}")
            raise HTTPException(status_code=500, detail=f"Failed to save file: {str(write_error)}")

        result = {
            "success": True,
            "patch_name": safe_name,
            "patch_path": str(stored_path),
            "uploaded_at": datetime.utcnow().isoformat() + "Z",
            "message": "DJI patch uploaded successfully.",
        }
        logger.info(f"DJI patch upload successful: {result}")
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Failed to upload DJI patch: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

async def start_mmyolo_training(
    request: MMYOLOTrainingRequest,
    db: Session = Depends(get_db),
):
    """
        Start MMYOLO (YOLOv8 + RTMDet family) training.

    Supported architectures:
            - yolov8      → YOLOv8 detection
      - rtmdet      → RTMDet detection
      - rtmdet-ins  → RTMDet instance segmentation
      - rtmdet-r    → RTMDet-Rotated oriented bounding boxes

    Training runs via `mim run mmyolo train` inside the Celery worker.
    """
    try:
        # Validate arch+size combination
        try:
            config_id = mmyolo_config_name(request.arch, request.size)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

        # Validate datasets and annotation files exist
        for cfg in request.dataset_configs:
            dataset = db.query(Dataset).filter(Dataset.id == cfg["dataset_id"]).first()
            if not dataset:
                raise HTTPException(
                    status_code=404, detail=f"Dataset {cfg['dataset_id']} not found"
                )
            ann_file = db.query(AnnotationFile).filter(
                AnnotationFile.id == cfg["annotation_file_id"]
            ).first()
            if not ann_file:
                raise HTTPException(
                    status_code=404,
                    detail=f"Annotation file {cfg['annotation_file_id']} not found",
                )

        if request.dji_patch_path:
            patch_path = Path(request.dji_patch_path)
            if not patch_path.exists() or not patch_path.is_file():
                raise HTTPException(status_code=400, detail="Provided DJI patch file does not exist.")
            if patch_path.suffix.lower() != ".patch":
                raise HTTPException(status_code=400, detail="DJI patch must be a .patch file.")

        task_name = (
            request.task_name
            or f"MMYOLO {request.arch.upper()} ({request.size.upper()}) — "
               f"{datetime.utcnow().strftime('%Y-%m-%d %H:%M')}"
        )

        task = Task(
            name=task_name,
            description=(
                f"MMYOLO training: {request.arch} · {request.size} · {request.task} "
                f"on {len(request.dataset_configs)} dataset(s)"
            ),
            task_type="mmyolo_training",
            status="pending",
            project_id=request.project_id,
            progress=0,
            task_metadata={
                "framework_id": "mmyolo",
                "model_type": f"{request.arch}_{request.size}",
                "arch": request.arch,
                "size": request.size,
                "mmyolo_task": request.task,
                "config_id": config_id,
                "epochs": request.epochs,
                "batch_size": request.batch_size,
                "image_size": request.image_size,
                "dataset_count": len(request.dataset_configs),
                "dataset_ids": [c["dataset_id"] for c in request.dataset_configs],
                "dataset_configs": request.dataset_configs,
                "training_params": {
                    "epochs": request.epochs,
                    "batch_size": request.batch_size,
                    "image_size": request.image_size,
                    "device": request.device,
                    "optimizer": request.optimizer,
                    "learning_rate": request.learning_rate,
                    "weight_decay": request.weight_decay,
                    "save_period": request.save_period,
                },
                "remove_images_without_annotations": request.remove_images_without_annotations,
                "dji_patch_path": request.dji_patch_path,
                "use_wandb": request.use_wandb,
                "wandb_project": request.wandb_project,
                "wandb_entity": request.wandb_entity,
            },
        )
        db.add(task)
        db.commit()
        db.refresh(task)

        training_config = {
            "project_id": request.project_id,
            "dataset_configs": request.dataset_configs,
            "arch": request.arch,
            "size": request.size,
            "task": request.task,
            "config_id": config_id,
            "epochs": request.epochs,
            "batch_size": request.batch_size,
            "image_size": request.image_size,
            "device": request.device,
            "optimizer": request.optimizer,
            "learning_rate": request.learning_rate,
            "weight_decay": request.weight_decay,
            "save_period": request.save_period,
            "remove_images_without_annotations": request.remove_images_without_annotations,
            "dji_patch_path": request.dji_patch_path,
            "dji_use_widen_factor_025": request.dji_use_widen_factor_025,
            "use_wandb": request.use_wandb,
            "wandb_project": request.wandb_project,
            "wandb_entity": request.wandb_entity,
        }

        if USE_CELERY and celery_mmyolo_task is not None:
            from app.ml.celery_dispatch import enqueue_training_task

            celery_task = enqueue_training_task(
                celery_mmyolo_task, task.id, training_config, "mmyolo"
            )
            logger.info(
                f"Queued MMYOLO training task {task.id} in Celery (celery_id: {celery_task.id})"
            )
            task.task_metadata = {**task.task_metadata, "celery_task_id": celery_task.id}
            db.commit()
        else:
            logger.warning("Celery not available; MMYOLO training cannot run without Celery worker.")
            task.status = "failed"
            task.error_message = "Celery worker not available — cannot start MMYOLO training."
            db.commit()
            raise HTTPException(
                status_code=503,
                detail="Celery worker is required for MMYOLO training but is not available.",
            )

        return {
            "success": True,
            "task_id": task.id,
            "message": f"MMYOLO training started ({request.arch} · {request.size})",
            "task": {
                "id": task.id,
                "name": task.name,
                "status": task.status,
                "progress": task.progress,
            },
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Error starting MMYOLO training: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
