"""Tests for training rerun dataset config reconstruction."""
import pytest

from app.services.training_dataset_config import (
    normalize_training_dataset_config,
    reconstruct_dataset_configs_from_metadata,
)

# Realistic UUID saved by the frontend / start_yolo_training metadata.
SAMPLE_ANN_FILE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
SAMPLE_DATASET_ID = 677


def _saved_yolo_task_metadata() -> dict:
    """Shape persisted on Task.task_metadata after a successful YOLO train start."""
    return {
        "framework_id": "ultralytics.yolo",
        "model_type": "yolo26m.pt",
        "dataset_ids": [SAMPLE_DATASET_ID],
        "dataset_configs": [
            {
                "dataset_id": SAMPLE_DATASET_ID,
                "dataset_name": "Cars",
                "annotation_file_id": SAMPLE_ANN_FILE_ID,
                "annotation_file_name": "car_bb",
                "image_collection": None,
                "split": {"train": 80, "val": 20, "test": 0},
            }
        ],
        "remove_images_without_annotations": True,
    }


def _legacy_broken_normalize(config: dict):
    """Pre-fix rerun logic that caused 0 mAP on rerun (regression reference)."""
    dataset_id = config.get("dataset_id")
    annotation_file_id = config.get("annotation_file_id")
    if not dataset_id or annotation_file_id is None:
        return None
    try:
        annotation_file_id = (
            int(annotation_file_id) if isinstance(annotation_file_id, str) else annotation_file_id
        )
        dataset_id = int(dataset_id) if isinstance(dataset_id, str) else dataset_id
    except (ValueError, TypeError):
        return None
    return {"dataset_id": dataset_id, "annotation_file_id": annotation_file_id}


def test_normalize_preserves_uuid_annotation_file_id():
    cfg = {
        "dataset_id": SAMPLE_DATASET_ID,
        "annotation_file_id": SAMPLE_ANN_FILE_ID,
        "split": {"train": 70, "val": 30, "test": 0},
    }
    out = normalize_training_dataset_config(cfg)
    assert out is not None
    assert out["dataset_id"] == SAMPLE_DATASET_ID
    assert out["annotation_file_id"] == SAMPLE_ANN_FILE_ID
    assert out["split"] == {"train": 70, "val": 30, "test": 0}


def test_normalize_uuid_with_leading_digits_not_coerced_to_int():
    """Regression: int(uuid_string) used to fail and trigger wrong fallback ann file."""
    cfg = {
        "dataset_id": "42",
        "annotation_file_id": "12345abc-def0-1234-abcd-ef0123456789",
    }
    out = normalize_training_dataset_config(cfg)
    assert out is not None
    assert out["dataset_id"] == 42
    assert out["annotation_file_id"] == "12345abc-def0-1234-abcd-ef0123456789"


def test_normalize_rejects_missing_annotation_file_id():
    assert normalize_training_dataset_config({"dataset_id": 1}) is None
    assert normalize_training_dataset_config({"dataset_id": 1, "annotation_file_id": ""}) is None


def test_normalize_default_split():
    out = normalize_training_dataset_config(
        {"dataset_id": 1, "annotation_file_id": "ann-uuid"}
    )
    assert out["split"] == {"train": 80, "val": 20, "test": 0}


def test_reconstruct_from_saved_task_metadata():
    """Rerun must recover the exact annotation file UUID from stored metadata."""
    meta = _saved_yolo_task_metadata()
    configs = reconstruct_dataset_configs_from_metadata(meta["dataset_configs"])
    assert len(configs) == 1
    assert configs[0]["dataset_id"] == SAMPLE_DATASET_ID
    assert configs[0]["annotation_file_id"] == SAMPLE_ANN_FILE_ID
    assert configs[0]["split"] == {"train": 80, "val": 20, "test": 0}


def test_legacy_int_coercion_drops_uuid_metadata_regression():
    """
    Documents the bug: old rerun int() on annotation_file_id dropped all configs,
    forcing a heuristic fallback that often picked the wrong annotation file → 0 mAP.
    """
    meta = _saved_yolo_task_metadata()
    raw_configs = meta["dataset_configs"]

    legacy = [
        c
        for c in (_legacy_broken_normalize(row) for row in raw_configs)
        if c is not None
    ]
    fixed = reconstruct_dataset_configs_from_metadata(raw_configs)

    assert legacy == [], "legacy int() coercion must fail on UUID annotation_file_id"
    assert len(fixed) == 1
    assert fixed[0]["annotation_file_id"] == SAMPLE_ANN_FILE_ID


def test_reconstruct_empty_when_all_entries_invalid():
    assert reconstruct_dataset_configs_from_metadata([]) == []
    assert reconstruct_dataset_configs_from_metadata(None) == []
    assert reconstruct_dataset_configs_from_metadata(
        [{"dataset_id": 1}]  # missing annotation_file_id
    ) == []


@pytest.mark.parametrize(
    "annotation_file_id",
    [
        SAMPLE_ANN_FILE_ID,
        "12345abc-def0-1234-abcd-ef0123456789",
        "pure-alpha-uuid-no-digits",
    ],
)
def test_annotation_file_id_never_coerced_to_int(annotation_file_id: str):
    out = normalize_training_dataset_config(
        {"dataset_id": 1, "annotation_file_id": annotation_file_id}
    )
    assert out is not None
    assert isinstance(out["annotation_file_id"], str)
    assert out["annotation_file_id"] == annotation_file_id
