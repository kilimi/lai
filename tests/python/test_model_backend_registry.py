"""Tests for model backend registry."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import pytest

from app.ml.protocols import ModelBackend
from app.ml.registry import (
    clear_registry,
    get_backend,
    get_backend_for_task,
    list_backends,
    register_backend,
)
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


@dataclass
class MockBackend:
    id: str = "mock.backend"
    display_name: str = "Mock Backend"
    runtime_profile: str = "mock"

    def catalog(self) -> ModelCatalog:
        return ModelCatalog(
            backend_id=self.id,
            display_name=self.display_name,
            variants=[
                ModelVariant(id="tiny", display_name="Tiny", task=VisionTask.DETECT),
            ],
            runtime_profile=self.runtime_profile,
        )

    def validate_start_request(self, body: Dict[str, Any]) -> TrainingStartSpec:
        return TrainingStartSpec(
            framework_id=self.id,
            variant=body.get("variant", "tiny"),
            task=VisionTask.DETECT,
            training_params=body,
        )

    def prepare_dataset(self, ctx: DatasetContext) -> DatasetArtifact:
        return DatasetArtifact(
            output_dir=ctx.output_dir,
            format="yolo",
            class_names=["a"],
            class_count=1,
            image_counts={"train": 1},
        )

    def train(self, ctx: TrainContext) -> TrainResult:
        return TrainResult(best_checkpoint="/tmp/best.pt")

    def resolve_checkpoint(self, task_meta: Dict[str, Any], name: str) -> CheckpointInfo:
        key = "best_model" if name == "best" else "last_model"
        return CheckpointInfo(
            path=__import__("pathlib").Path(task_meta[key]),
            name=name,
            framework_id=self.id,
        )

    def run_inference(self, ctx: InferenceContext) -> List[PredictionRecord]:
        return []

    def parse_training_metrics(
        self,
        line: Optional[str],
        trainer_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[MetricsUpdate]:
        return None

    def supports_export(self) -> bool:
        return False

    def supports_pause_resume(self) -> bool:
        return True

    def legacy_task_types(self) -> List[str]:
        return ["mock_training"]

    def to_backend_info(self) -> BackendInfo:
        return BackendInfo(
            id=self.id,
            display_name=self.display_name,
            runtime_profile=self.runtime_profile,
            supports_export=self.supports_export(),
            supports_pause_resume=self.supports_pause_resume(),
        )


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    yield
    clear_registry()


def test_register_and_get_backend():
    backend = MockBackend()
    register_backend(backend)
    assert get_backend("mock.backend") is backend
    assert len(list_backends()) == 1


def test_get_backend_unknown_raises():
    with pytest.raises(KeyError, match="Unknown model backend"):
        get_backend("nonexistent")


def test_lazy_builtin_registration_without_explicit_fixture():
    """Celery workers resolve backends without importing main.py."""
    clear_registry()
    backend = get_backend("ultralytics.yolo")
    assert backend.id == "ultralytics.yolo"
    assert "mmyolo" in {b.id for b in list_backends()}


def test_get_backend_for_task_legacy_task_type():
    register_backend(MockBackend())
    task = {"task_type": "mock_training", "task_metadata": {}}
    assert get_backend_for_task(task).id == "mock.backend"


def test_get_backend_for_task_framework_id():
    register_backend(MockBackend())
    task = {
        "task_type": "model_training",
        "task_metadata": {"framework_id": "mock.backend"},
    }
    assert get_backend_for_task(task).id == "mock.backend"


def test_mock_backend_satisfies_protocol():
    backend = MockBackend()
    assert isinstance(backend, ModelBackend)
