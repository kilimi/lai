"""Tests for shared YOLO evaluation helpers."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np

from app.tasks.evaluation_helpers import (
    extract_yolo_image_predictions,
    resolve_evaluation_class_names,
    resolve_evaluation_imgsz,
)


def test_resolve_evaluation_imgsz_prefers_request():
    meta = {"training_config": {"image_size": 1280}}
    assert resolve_evaluation_imgsz(meta, 960) == (960, "request")


def test_resolve_evaluation_imgsz_reads_training_config():
    meta = {"training_config": {"imgsz": 1280}, "training_params": {"image_size": 640}}
    assert resolve_evaluation_imgsz(meta, None) == (1280, "training_config.imgsz")


def test_resolve_evaluation_class_names_prefers_matching_metadata():
    model = SimpleNamespace(
        names={0: "car", 1: "person"},
        model=SimpleNamespace(nc=2),
    )
    names, nc = resolve_evaluation_class_names(
        model,
        {"class_names": ["car", "person"]},
    )
    assert nc == 2
    assert names == ["car", "person"]


def test_resolve_evaluation_class_names_uses_model_when_metadata_stale():
    model = SimpleNamespace(
        names={0: "a", 1: "b", 2: "c"},
        model=SimpleNamespace(nc=3),
    )
    names, nc = resolve_evaluation_class_names(
        model,
        {"class_names": ["a", "b"]},
    )
    assert nc == 3
    assert names == ["a", "b", "c"]


def test_extract_yolo_image_predictions_filters_out_of_range_classes():
    boxes = MagicMock()
    boxes.xyxy = MagicMock()
    boxes.xyxy.cpu.return_value.numpy.return_value = np.array(
        [[10.0, 10.0, 50.0, 50.0], [12.0, 12.0, 52.0, 52.0]]
    )
    boxes.conf = MagicMock()
    boxes.conf.cpu.return_value.numpy.return_value = np.array([0.9, 0.8])
    boxes.cls = MagicMock()
    boxes.cls.cpu.return_value.numpy.return_value = np.array([0.0, 5.0])
    boxes.__len__ = MagicMock(return_value=2)

    result = SimpleNamespace(boxes=boxes, masks=None)
    preds, raw_n, dropped = extract_yolo_image_predictions(
        result,
        image_id=1,
        num_classes=3,
        is_segmentation_model=False,
    )
    assert raw_n == 2
    assert dropped == 1
    assert len(preds) == 1
    assert preds[0]["class_id"] == 0
