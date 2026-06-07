"""Pydantic request models for training APIs."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, field_validator, model_validator

from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name

class YoloTrainingRequest(BaseModel):
    """Request model for YOLO training"""
    project_id: int
    dataset_configs: List[Dict[str, Any]]  # List of {dataset_id, annotation_file_id, image_collection, split: {train, val, test}}
    model_type: str = "yolo11n-seg.pt"  # YOLO model variant
    epochs: int = 100
    batch_size: int = 16
    image_size: int = 640
    device: str = "0"  # GPU device or "cpu"
    task_name: Optional[str] = None
    # Additional YOLO training parameters
    patience: int = 50
    optimizer: str = "auto"
    learning_rate: float = 0.01
    momentum: float = 0.937
    weight_decay: float = 0.0005
    save_period: int = -1  # -1 = only best and last, or save every N epochs
    augmentations: Optional[Dict[str, Any]] = None  # Augmentation settings
    remove_images_without_annotations: bool = True  # Remove images that have no annotations
    # Weights & Biases integration
    use_wandb: bool = False
    wandb_project: Optional[str] = None
    wandb_entity: Optional[str] = None

    @field_validator("model_type")
    @classmethod
    def _normalize_model_type(cls, v: str) -> str:
        raw = (v or "").strip()
        if not raw:
            return "yolo11n-seg.pt"
        if re.match(r"^yolo_?nas", raw, re.IGNORECASE):
            raise ValueError("YOLO-NAS models are no longer supported")
        return raw


class RTDETRTrainingRequest(BaseModel):
    """Request model for RT-DETR training"""
    project_id: int
    dataset_configs: List[Dict[str, Any]]
    model_type: str = "rtdetr-l.pt"  # RT-DETR model variant (rtdetr-l.pt or rtdetr-x.pt)
    epochs: int = 100
    batch_size: int = 16
    image_size: int = 640
    device: str = "0"
    task_name: Optional[str] = None
    # RT-DETR specific parameters
    patience: int = 50
    optimizer: str = "AdamW"
    learning_rate: float = 0.0001
    weight_decay: float = 0.0001
    save_period: int = -1  # -1 = only best and last, or save every N epochs
    # Weights & Biases integration
    use_wandb: bool = False
    wandb_project: Optional[str] = None
    wandb_entity: Optional[str] = None


# ── MMYOLO (OpenMMLab RTMDet family) ─────────────────────────────────────────
from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name


class MMYOLOTrainingRequest(BaseModel):
    """Request model for MMYOLO (YOLOv8 + RTMDet family) training."""
    project_id: int
    dataset_configs: List[Dict[str, Any]]
    arch: str = "rtmdet"          # yolov8 | rtmdet | rtmdet-ins | rtmdet-r
    size: str = "s"               # tiny | s | m | l | x
    task: str = "detect"          # detect | segment | oriented
    epochs: int = 300
    batch_size: int = 16
    image_size: int = 640
    device: str = "0"
    task_name: Optional[str] = None
    optimizer: str = "AdamW"
    learning_rate: float = 0.004
    weight_decay: float = 0.05
    save_period: int = -1
    remove_images_without_annotations: bool = True
    dji_patch_path: Optional[str] = None
    dji_use_widen_factor_025: bool = True
    use_wandb: bool = False
    wandb_project: Optional[str] = None
    wandb_entity: Optional[str] = None

    @field_validator("arch")
    @classmethod
    def _validate_arch(cls, v: str) -> str:
        if v not in MMYOLO_VALID_ARCHS:
            raise ValueError(f"arch must be one of {sorted(MMYOLO_VALID_ARCHS)}, got '{v}'")
        return v

    @field_validator("size")
    @classmethod
    def _validate_size(cls, v: str) -> str:
        if v not in MMYOLO_VALID_SIZES:
            raise ValueError(f"size must be one of {sorted(MMYOLO_VALID_SIZES)}, got '{v}'")
        return v

    @field_validator("task")
    @classmethod
    def _validate_task(cls, v: str) -> str:
        if v not in {"detect", "segment", "oriented"}:
            raise ValueError(f"task must be one of detect, segment, oriented, got '{v}'")
        return v

    @model_validator(mode="after")
    def _validate_arch_task_combo(self):
        if self.arch == "yolov8" and self.task != "detect":
            raise ValueError("arch 'yolov8' supports only task='detect'")
        return self


