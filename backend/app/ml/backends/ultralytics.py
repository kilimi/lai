"""Ultralytics YOLO and RT-DETR model backends."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.foundation_models import ARCH_SIZES, TASK_SUFFIXES
from app.ml.dataset import prepare_yolo_dataset
from app.ml.inference.ultralytics_runner import postprocess_ultralytics_results
from app.ml.schemas import (
    BackendInfo,
    CheckpointInfo,
    DatasetArtifact,
    DatasetContext,
    InferenceContext,
    MetricsUpdate,
    ModelCatalog,
    ModelVariant,
    PredictionRecord,
    TrainContext,
    TrainResult,
    TrainingStartSpec,
    VisionTask,
)

logger = logging.getLogger(__name__)


class _UltralyticsBackendBase:
    """Shared Ultralytics training/eval/inference logic."""

    runtime_profile: str = "ultralytics"
    supports_export: bool = True
    supports_pause_resume: bool = True

    def __init__(self, backend_id: str, display_name: str, legacy_task_types: List[str], use_rtdetr: bool):
        self.id = backend_id
        self.display_name = display_name
        self._legacy_task_types = legacy_task_types
        self._use_rtdetr = use_rtdetr

    def legacy_task_types(self) -> List[str]:
        return list(self._legacy_task_types)

    def catalog(self) -> ModelCatalog:
        variants: List[ModelVariant] = []
        for arch, size in ARCH_SIZES:
            if self._use_rtdetr and not arch.startswith("rtdetr"):
                continue
            if not self._use_rtdetr and arch.startswith("rtdetr"):
                continue
            base = f"{arch}{size}"
            for suf in TASK_SUFFIXES:
                if self._use_rtdetr and suf:
                    continue
                pt_name = f"{base}{suf}.pt" if suf else f"{base}.pt"
                if suf == "-seg":
                    task = VisionTask.SEGMENT
                elif suf == "-cls":
                    task = VisionTask.CLASSIFY
                else:
                    task = VisionTask.DETECT
                variants.append(
                    ModelVariant(
                        id=pt_name,
                        display_name=pt_name,
                        task=task,
                        pretrained_filename=pt_name,
                    )
                )
        return ModelCatalog(
            backend_id=self.id,
            display_name=self.display_name,
            variants=variants,
            runtime_profile=self.runtime_profile,
            supports_export=self.supports_export(),
            supports_pause_resume=self.supports_pause_resume(),
            request_schema={
                "type": "object",
                "required": ["project_id", "dataset_configs", "model_type"],
                "properties": {
                    "model_type": {"type": "string"},
                    "epochs": {"type": "integer"},
                    "batch_size": {"type": "integer"},
                    "image_size": {"type": "integer"},
                },
            },
        )

    def validate_start_request(self, body: Dict[str, Any]) -> TrainingStartSpec:
        model_type = str(body.get("model_type", "yolo11n-seg.pt" if not self._use_rtdetr else "rtdetr-l.pt"))
        if "-seg" in model_type.lower():
            task = VisionTask.SEGMENT
        elif "-cls" in model_type.lower():
            task = VisionTask.CLASSIFY
        else:
            task = VisionTask.DETECT
        return TrainingStartSpec(
            framework_id=self.id,
            variant=model_type,
            task=task,
            training_params=dict(body),
            legacy_metadata={
                "model_type": model_type,
                "framework_id": self.id,
            },
        )

    def prepare_dataset(self, ctx: DatasetContext) -> DatasetArtifact:
        default_model = "rtdetr-l.pt" if self._use_rtdetr else "yolo11n-seg.pt"
        result = prepare_yolo_dataset(
            ctx.db,
            ctx.dataset_configs,
            ctx.output_dir,
            model_type=ctx.model_type or default_model,
            remove_images_without_annotations=ctx.remove_images_without_annotations,
        )
        return DatasetArtifact(
            output_dir=ctx.output_dir,
            format="yolo",
            class_names=result.get("class_names", []),
            class_count=result.get("class_count", 0),
            image_counts=result.get("image_counts", {}),
            data_yaml=result.get("yaml_path"),
            stats=result.get("dataset_stats", {}),
        )

    def train(self, ctx: TrainContext) -> TrainResult:
        """Execute training in-process (Celery worker calls this via thin wrapper)."""
        if self._use_rtdetr:
            from app.tasks.rtdetr_training import train_rtdetr_model

            train_rtdetr_model.run(ctx.task_id, ctx.config)
        else:
            from app.tasks.yolo_training import YOLOTrainingTask

            YOLOTrainingTask().execute(ctx.task_id, ctx.config)
        return TrainResult()

    def resolve_checkpoint(self, task_meta: Dict[str, Any], name: str) -> CheckpointInfo:
        path_str: Optional[str] = None
        if name == "best":
            path_str = task_meta.get("best_model")
        elif name == "last":
            path_str = task_meta.get("last_model")
        elif task_meta.get("results_dir"):
            weights_dir = Path(task_meta["results_dir"]) / "weights"
            for ext in (".pt", ".pth"):
                candidate = weights_dir / f"{name}{ext}"
                if candidate.exists():
                    path_str = str(candidate)
                    break
                candidate = weights_dir / name
                if candidate.exists():
                    path_str = str(candidate)
                    break
        if not path_str:
            raise FileNotFoundError(f"Checkpoint '{name}' not found in task metadata")
        return CheckpointInfo(path=Path(path_str), name=name, framework_id=self.id)

    def run_inference(self, ctx: InferenceContext) -> List[PredictionRecord]:
        if self._use_rtdetr:
            from app.tasks.training_common import get_ultralytics_rtdetr

            ModelCls = get_ultralytics_rtdetr()
        else:
            from app.tasks.training_common import get_ultralytics_yolo

            ModelCls = get_ultralytics_yolo()

        model = ModelCls(str(ctx.checkpoint.path))
        results = model.predict(
            source=[str(p) for p in ctx.image_paths],
            conf=ctx.conf_threshold,
            iou=ctx.iou_threshold,
            verbose=False,
        )
        if not isinstance(results, list):
            results = [results]
        return postprocess_ultralytics_results(results, ctx.image_ids, ctx.conf_threshold)

    def parse_training_metrics(
        self,
        line: Optional[str],
        trainer_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[MetricsUpdate]:
        return None

    def supports_export(self) -> bool:
        return True

    def supports_pause_resume(self) -> bool:
        return True

    def to_backend_info(self) -> BackendInfo:
        return BackendInfo(
            id=self.id,
            display_name=self.display_name,
            runtime_profile=self.runtime_profile,
            supports_export=self.supports_export(),
            supports_pause_resume=self.supports_pause_resume(),
        )

    @property
    def celery_train_task(self) -> str:
        return "app.tasks.training_tasks.train_rtdetr_model" if self._use_rtdetr else "app.tasks.training_tasks.train_yolo_model"


class UltralyticsYoloBackend(_UltralyticsBackendBase):
    def __init__(self) -> None:
        super().__init__(
            "ultralytics.yolo",
            "Ultralytics YOLO",
            ["yolo_training", "model_training"],
            use_rtdetr=False,
        )


class UltralyticsRTDETRBackend(_UltralyticsBackendBase):
    def __init__(self) -> None:
        super().__init__(
            "ultralytics.rtdetr",
            "Ultralytics RT-DETR",
            ["training"],
            use_rtdetr=True,
        )
