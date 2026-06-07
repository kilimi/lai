"""Shared schemas for model backend plugins."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional


class VisionTask(str, Enum):
    DETECT = "detect"
    SEGMENT = "segment"
    CLASSIFY = "classify"
    ORIENTED = "oriented"


@dataclass(frozen=True)
class ModelVariant:
    """A selectable model variant within a backend catalog."""

    id: str
    display_name: str
    task: VisionTask
    pretrained_filename: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ModelCatalog:
    """Catalog of variants exposed by a backend (for UI / API)."""

    backend_id: str
    display_name: str
    variants: List[ModelVariant]
    runtime_profile: str
    supports_export: bool = False
    supports_pause_resume: bool = False
    request_schema: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TrainingStartSpec:
    """Normalized training start request after backend validation."""

    framework_id: str
    variant: str
    task: VisionTask
    training_params: Dict[str, Any]
    legacy_metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DatasetContext:
    """Input for dataset preparation."""

    db: Any
    dataset_configs: List[Dict[str, Any]]
    output_dir: Path
    task: VisionTask = VisionTask.DETECT
    model_type: str = ""
    remove_images_without_annotations: bool = True


@dataclass
class DatasetArtifact:
    """Output of dataset preparation."""

    output_dir: Path
    format: Literal["yolo", "coco"]
    class_names: List[str]
    class_count: int
    image_counts: Dict[str, int]
    data_yaml: Optional[str] = None
    train_json: Optional[str] = None
    val_json: Optional[str] = None
    stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CheckpointInfo:
    """Resolved checkpoint path and metadata."""

    path: Path
    name: str
    framework_id: str


@dataclass
class PredictionRecord:
    """Framework-agnostic prediction for evaluation and inference."""

    image_id: int
    class_id: int
    conf: float
    bbox_xywh: List[float]
    bbox_xyxy: Optional[List[float]] = None
    segmentation: Optional[List[List[float]]] = None

    def to_eval_dict(self) -> Dict[str, Any]:
        """Convert to the dict format used by evaluation_tasks / mmyolo_evaluation."""
        out: Dict[str, Any] = {
            "image_id": self.image_id,
            "class_id": self.class_id,
            "bbox": list(self.bbox_xywh),
            "conf": self.conf,
            "segmentation": self.segmentation or [],
        }
        if self.bbox_xyxy is not None:
            out["bbox_xyxy"] = list(self.bbox_xyxy)
        return out


@dataclass
class TrainContext:
    """Context passed to backend.train()."""

    celery_task: Any
    task_id: int
    config: Dict[str, Any]


@dataclass
class TrainResult:
    """Result of a training run."""

    best_checkpoint: Optional[str] = None
    last_checkpoint: Optional[str] = None
    metadata_updates: Dict[str, Any] = field(default_factory=dict)


@dataclass
class InferenceContext:
    """Context for single-image or batch inference."""

    checkpoint: CheckpointInfo
    image_paths: List[Path]
    image_ids: List[int]
    class_names: List[str]
    conf_threshold: float = 0.25
    iou_threshold: float = 0.45
    task: VisionTask = VisionTask.DETECT
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MetricsUpdate:
    """Parsed training metrics update."""

    epoch: Optional[int] = None
    metrics: Dict[str, float] = field(default_factory=dict)
    raw_line: Optional[str] = None


@dataclass
class BackendInfo:
    """Summary info for registry listing."""

    id: str
    display_name: str
    runtime_profile: str
    supports_export: bool
    supports_pause_resume: bool
