"""
TDD tests for MMYOLO training endpoint.

These tests cover:
- MMYOLOTrainingRequest schema validation
- arch/size → config name resolution
- Endpoint-level logic (request parsing, arch guarding)

No Celery, DB, or filesystem I/O — pure unit tests.
"""
import pytest
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


# ── Schema import (will fail until implemented) ──────────────────────────────

from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name
from app.services.training_schemas import MMYOLOTrainingRequest


# ── MMYOLOTrainingRequest schema ─────────────────────────────────────────────

class TestMMYOLOTrainingRequestSchema:
    def test_minimal_valid_request(self):
        req = MMYOLOTrainingRequest(
            project_id=1,
            dataset_configs=[{"dataset_id": 1, "annotation_file_id": 2}],
            arch="rtmdet",
            size="s",
        )
        assert req.project_id == 1
        assert req.arch == "rtmdet"
        assert req.size == "s"
        assert req.task == "detect"          # default
        assert req.epochs == 300             # default
        assert req.batch_size == 16          # default
        assert req.image_size == 640         # default

    def test_defaults_for_rtmdet_ins(self):
        req = MMYOLOTrainingRequest(
            project_id=2,
            dataset_configs=[{"dataset_id": 3, "annotation_file_id": 4}],
            arch="rtmdet-ins",
            size="m",
            task="segment",
        )
        assert req.task == "segment"
        assert req.optimizer == "AdamW"      # default for MMYOLO

    def test_defaults_for_rtmdet_rotated(self):
        req = MMYOLOTrainingRequest(
            project_id=3,
            dataset_configs=[{"dataset_id": 5, "annotation_file_id": 6}],
            arch="rtmdet-r",
            size="l",
            task="oriented",
        )
        assert req.task == "oriented"

    def test_all_valid_archs_accepted(self):
        for arch in MMYOLO_VALID_ARCHS:
            req = MMYOLOTrainingRequest(
                project_id=1,
                dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
                arch=arch,
                size="s",
            )
            assert req.arch == arch

    def test_all_valid_sizes_accepted(self):
        for size in MMYOLO_VALID_SIZES:
            req = MMYOLOTrainingRequest(
                project_id=1,
                dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
                arch="rtmdet",
                size=size,
            )
            assert req.size == size

    def test_invalid_arch_raises(self):
        with pytest.raises(Exception):
            MMYOLOTrainingRequest(
                project_id=1,
                dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
                arch="not-a-real-arch",
                size="s",
            )

    def test_invalid_size_raises(self):
        with pytest.raises(Exception):
            MMYOLOTrainingRequest(
                project_id=1,
                dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
                arch="rtmdet",
                size="xxl",
            )

    def test_invalid_task_raises(self):
        with pytest.raises(Exception):
            MMYOLOTrainingRequest(
                project_id=1,
                dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
                arch="rtmdet",
                size="s",
                task="invalid_task",
            )

    def test_wandb_fields(self):
        req = MMYOLOTrainingRequest(
            project_id=1,
            dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
            arch="rtmdet",
            size="s",
            use_wandb=True,
            wandb_project="my-project",
            wandb_entity="my-org",
        )
        assert req.use_wandb is True
        assert req.wandb_project == "my-project"
        assert req.wandb_entity == "my-org"

    def test_custom_training_params(self):
        req = MMYOLOTrainingRequest(
            project_id=1,
            dataset_configs=[{"dataset_id": 1, "annotation_file_id": 1}],
            arch="rtmdet",
            size="l",
            epochs=150,
            batch_size=8,
            image_size=1280,
            learning_rate=0.002,
            weight_decay=0.01,
        )
        assert req.epochs == 150
        assert req.batch_size == 8
        assert req.image_size == 1280
        assert req.learning_rate == 0.002
        assert req.weight_decay == 0.01


# ── mmyolo_config_name resolution ────────────────────────────────────────────

class TestMmyoloConfigName:
    """mmyolo_config_name(arch, size) → config string passed to mim/mmyolo."""

    def test_rtmdet_small(self):
        name = mmyolo_config_name("rtmdet", "s")
        assert "rtmdet" in name.lower()
        assert "_s" in name or "-s" in name or name.endswith("s")

    def test_rtmdet_ins_medium(self):
        name = mmyolo_config_name("rtmdet-ins", "m")
        assert "rtmdet" in name.lower()
        assert "ins" in name.lower()

    def test_rtmdet_rotated_large(self):
        name = mmyolo_config_name("rtmdet-r", "l")
        assert "rtmdet" in name.lower()
        # rotated / r should appear in the config name
        assert "r" in name.lower()

    def test_tiny_size(self):
        name = mmyolo_config_name("rtmdet", "tiny")
        assert "tiny" in name.lower()

    def test_xlarge_size(self):
        name = mmyolo_config_name("rtmdet", "x")
        assert "x" in name.lower()

    def test_unknown_arch_raises_value_error(self):
        with pytest.raises(ValueError):
            mmyolo_config_name("unknown-arch", "s")

    def test_unknown_size_raises_value_error(self):
        with pytest.raises(ValueError):
            mmyolo_config_name("rtmdet", "mega")
