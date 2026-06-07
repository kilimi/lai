"""YOLO dataset export must emit detection labels for detection models."""
from types import SimpleNamespace

from app.ml.dataset.formats.yolo import (
    _append_yolo_detection_bbox,
    _yolo_detection_line_from_bbox,
)


def test_detection_line_from_normalized_bbox_columns():
    line = _yolo_detection_line_from_bbox(
        0,
        x=0.1,
        y=0.2,
        w=0.3,
        h=0.4,
        coords_are_normalized=True,
        img_width=960,
        img_height=540,
    )
    assert line == "0 0.250000 0.400000 0.300000 0.400000"


def test_detection_line_from_pixel_coco_bbox():
    line = _yolo_detection_line_from_bbox(
        1,
        x=100,
        y=50,
        w=200,
        h=100,
        coords_are_normalized=False,
        img_width=1000,
        img_height=500,
    )
    parts = line.split()
    assert parts[0] == "1"
    assert abs(float(parts[1]) - 0.2) < 1e-5
    assert abs(float(parts[2]) - 0.2) < 1e-5


def test_append_detection_uses_normalized_columns_not_double_scaled():
    ann = SimpleNamespace(
        bbox=None,
        bbox_x=0.1,
        bbox_y=0.2,
        bbox_width=0.3,
        bbox_height=0.4,
    )
    lines: list = []
    stats = {"annotations_per_class": {}, "total_annotations": {"train": 0, "val": 0, "test": 0}}
    ok = _append_yolo_detection_bbox(
        lines,
        ann,
        class_id=0,
        img_width=960,
        img_height=540,
        stats=stats,
        split_name="train",
        class_name="car",
    )
    assert ok
    assert lines[0].startswith("0 0.250000 0.400000")


def test_append_detection_handles_normalized_bbox_json_list():
    """Legacy bbox JSON stored as normalized xywh must not be treated as pixel coords."""
    ann = SimpleNamespace(
        bbox=[0.1, 0.2, 0.3, 0.4],
        bbox_x=None,
        bbox_y=None,
        bbox_width=None,
        bbox_height=None,
        segmentation=None,
    )
    lines: list = []
    stats = {"annotations_per_class": {}, "total_annotations": {"train": 0, "val": 0, "test": 0}}
    ok = _append_yolo_detection_bbox(
        lines,
        ann,
        class_id=0,
        img_width=960,
        img_height=540,
        stats=stats,
        split_name="train",
        class_name="car",
    )
    assert ok
    assert lines[0].startswith("0 0.250000 0.400000")


def test_append_detection_derives_bbox_from_mask_when_no_bbox():
    ann = SimpleNamespace(
        bbox=None,
        bbox_x=None,
        bbox_y=None,
        bbox_width=None,
        bbox_height=None,
        segmentation=[[10.0, 20.0, 110.0, 20.0, 110.0, 120.0, 10.0, 120.0]],
    )
    lines: list = []
    stats = {"annotations_per_class": {}, "total_annotations": {"train": 0, "val": 0, "test": 0}}
    ok = _append_yolo_detection_bbox(
        lines,
        ann,
        class_id=1,
        img_width=200,
        img_height=200,
        stats=stats,
        split_name="train",
        class_name="car",
    )
    assert ok
    parts = lines[0].split()
    assert parts[0] == "1"
    assert 0.0 < float(parts[1]) < 1.0
