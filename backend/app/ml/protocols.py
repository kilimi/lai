"""Model backend protocol definition."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

from app.ml.schemas import (
    BackendInfo,
    CheckpointInfo,
    DatasetArtifact,
    DatasetContext,
    InferenceContext,
    MetricsUpdate,
    ModelCatalog,
    PredictionRecord,
    TrainContext,
    TrainResult,
    TrainingStartSpec,
)


@runtime_checkable
class ModelBackend(Protocol):
    """Contract for trainable model framework plugins."""

    id: str
    display_name: str
    runtime_profile: str

    def catalog(self) -> ModelCatalog: ...

    def validate_start_request(self, body: Dict[str, Any]) -> TrainingStartSpec: ...

    def prepare_dataset(self, ctx: DatasetContext) -> DatasetArtifact: ...

    def train(self, ctx: TrainContext) -> TrainResult: ...

    def resolve_checkpoint(self, task_meta: Dict[str, Any], name: str) -> CheckpointInfo: ...

    def run_inference(self, ctx: InferenceContext) -> List[PredictionRecord]: ...

    def parse_training_metrics(
        self,
        line: Optional[str],
        trainer_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[MetricsUpdate]: ...

    def supports_export(self) -> bool: ...

    def supports_pause_resume(self) -> bool: ...

    def legacy_task_types(self) -> List[str]: ...

    def to_backend_info(self) -> BackendInfo:
        cat = self.catalog()
        return BackendInfo(
            id=self.id,
            display_name=self.display_name,
            runtime_profile=self.runtime_profile,
            supports_export=self.supports_export(),
            supports_pause_resume=self.supports_pause_resume(),
        )
