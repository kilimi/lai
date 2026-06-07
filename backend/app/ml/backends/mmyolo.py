"""MMYOLO model backend."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.ml.dataset import prepare_mmyolo_dataset
from app.ml.predictions import from_mmyolo_dict
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
from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name

logger = logging.getLogger(__name__)

_TASK_MAP = {
    "detect": VisionTask.DETECT,
    "segment": VisionTask.SEGMENT,
    "oriented": VisionTask.ORIENTED,
}


class MMYOLOBackend:
    id = "mmyolo"
    display_name = "MMYOLO (OpenMMLab)"
    runtime_profile = "mmyolo"

    def legacy_task_types(self) -> List[str]:
        return ["mmyolo_training"]

    def catalog(self) -> ModelCatalog:
        variants: List[ModelVariant] = []
        for arch in sorted(MMYOLO_VALID_ARCHS):
            for size in sorted(MMYOLO_VALID_SIZES):
                if arch == "yolov8" and size == "tiny":
                    continue
                config_id = mmyolo_config_name(arch, size)
                variants.append(
                    ModelVariant(
                        id=f"{arch}_{size}",
                        display_name=f"{arch} {size}",
                        task=VisionTask.DETECT,
                        metadata={"arch": arch, "size": size, "config_id": config_id},
                    )
                )
        return ModelCatalog(
            backend_id=self.id,
            display_name=self.display_name,
            variants=variants,
            runtime_profile=self.runtime_profile,
            supports_export=False,
            supports_pause_resume=False,
            request_schema={
                "type": "object",
                "required": ["project_id", "dataset_configs", "arch", "size", "task"],
                "properties": {
                    "arch": {"type": "string", "enum": sorted(MMYOLO_VALID_ARCHS)},
                    "size": {"type": "string", "enum": sorted(MMYOLO_VALID_SIZES)},
                    "task": {"type": "string", "enum": ["detect", "segment", "oriented"]},
                },
            },
        )

    def validate_start_request(self, body: Dict[str, Any]) -> TrainingStartSpec:
        arch = str(body.get("arch", "rtmdet"))
        size = str(body.get("size", "s"))
        task_str = str(body.get("task", "detect"))
        if arch not in MMYOLO_VALID_ARCHS:
            raise ValueError(f"Invalid arch: {arch}")
        if size not in MMYOLO_VALID_SIZES:
            raise ValueError(f"Invalid size: {size}")
        task = _TASK_MAP.get(task_str, VisionTask.DETECT)
        config_id = mmyolo_config_name(arch, size)
        return TrainingStartSpec(
            framework_id=self.id,
            variant=f"{arch}_{size}",
            task=task,
            training_params=dict(body),
            legacy_metadata={
                "arch": arch,
                "size": size,
                "mmyolo_task": task_str,
                "config_id": config_id,
                "framework_id": self.id,
            },
        )

    def prepare_dataset(self, ctx: DatasetContext) -> DatasetArtifact:
        task_str = ctx.task.value if isinstance(ctx.task, VisionTask) else str(ctx.task)
        result = prepare_mmyolo_dataset(
            ctx.db,
            ctx.dataset_configs,
            ctx.output_dir,
            task=task_str,
            remove_images_without_annotations=ctx.remove_images_without_annotations,
        )
        return DatasetArtifact(
            output_dir=ctx.output_dir,
            format="coco",
            class_names=result.get("class_names", []),
            class_count=result.get("class_count", 0),
            image_counts=result.get("image_counts", {}),
            train_json=result.get("train_json"),
            val_json=result.get("val_json"),
        )

    def train(self, ctx: TrainContext) -> TrainResult:
        from app.tasks.mmyolo_training import train_mmyolo_model

        train_mmyolo_model.run(ctx.task_id, ctx.config)
        return TrainResult()

    def resolve_checkpoint(self, task_meta: Dict[str, Any], name: str) -> CheckpointInfo:
        from app.tasks.mmyolo_evaluation import resolve_mmyolo_checkpoint

        path_str = resolve_mmyolo_checkpoint(task_meta, name)
        if not path_str:
            raise FileNotFoundError(f"MMYOLO checkpoint '{name}' not found")
        return CheckpointInfo(path=Path(path_str), name=name, framework_id=self.id)

    def run_inference(self, ctx: InferenceContext) -> List[PredictionRecord]:
        from app.tasks.mmyolo_evaluation import (
            run_mmyolo_inference_subprocess,
            resolve_mmyolo_config_path,
        )

        task_id = ctx.extra.get("task_id")
        task_meta = ctx.extra.get("task_metadata", {})
        config_path = resolve_mmyolo_config_path(task_id, task_meta)
        if not config_path:
            raise FileNotFoundError("MMYOLO config path not found for inference")

        class _ImageRef:
            def __init__(self, image_id: int) -> None:
                self.id = image_id

        items = [(_ImageRef(iid), p) for iid, p in zip(ctx.image_ids, ctx.image_paths)]
        raw_preds = run_mmyolo_inference_subprocess(
            config_path=config_path,
            checkpoint_path=str(ctx.checkpoint.path),
            items=items,
            num_classes=len(ctx.class_names),
            conf_threshold=ctx.conf_threshold,
            device=ctx.extra.get("device", "cpu"),
            dji_repo_dir=ctx.extra.get("dji_repo_dir"),
        )
        return [from_mmyolo_dict(p) for p in raw_preds]

    def parse_training_metrics(
        self,
        line: Optional[str],
        trainer_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[MetricsUpdate]:
        if not line:
            return None
        from app.tasks.mmyolo_metrics import parse_mmyolo_log_line

        parsed = parse_mmyolo_log_line(line)
        if not parsed:
            return None
        return MetricsUpdate(epoch=parsed.get("epoch"), metrics=parsed.get("metrics", {}), raw_line=line)

    def supports_export(self) -> bool:
        return False

    def supports_pause_resume(self) -> bool:
        return False

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
        return "app.tasks.training_tasks.train_mmyolo_model"
