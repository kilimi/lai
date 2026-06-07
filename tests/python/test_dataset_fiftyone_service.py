"""Tests for dataset FiftyOne export helpers."""
from types import SimpleNamespace

from app.services.dataset_fiftyone_service import (
    _annotation_bbox_pixel_xywh,
    _fiftyone_bbox_norm_from_annotation,
)


def _ann(**kwargs):
    return SimpleNamespace(
        bbox_x=kwargs.get("bbox_x"),
        bbox_y=kwargs.get("bbox_y"),
        bbox_width=kwargs.get("bbox_width"),
        bbox_height=kwargs.get("bbox_height"),
        bbox=kwargs.get("bbox"),
        segmentation=kwargs.get("segmentation"),
    )


def test_normalized_bbox_columns_stay_normalized_in_fiftyone():
    ann = _ann(bbox_x=0.1, bbox_y=0.2, bbox_width=0.3, bbox_height=0.4)
    assert _fiftyone_bbox_norm_from_annotation(ann, 640, 480) == [0.1, 0.2, 0.3, 0.4]


def test_pixel_bbox_columns_from_auto_annotate():
    ann = _ann(bbox_x=64.0, bbox_y=48.0, bbox_width=128.0, bbox_height=96.0)
    assert _fiftyone_bbox_norm_from_annotation(ann, 640, 480) == [0.1, 0.1, 0.2, 0.2]


def test_legacy_pixel_bbox_json():
    ann = _ann(bbox=[10, 20, 50, 80])
    norm = _fiftyone_bbox_norm_from_annotation(ann, 200, 100)
    assert norm == [0.05, 0.2, 0.25, 0.8]


def test_segmentation_only_yields_bbox_envelope():
    ann = _ann(segmentation=[10, 20, 60, 20, 60, 80, 10, 80])
    norm = _fiftyone_bbox_norm_from_annotation(ann, 100, 100)
    assert norm == [0.1, 0.2, 0.5, 0.6]


def test_annotation_bbox_pixel_xywh_normalized_columns():
    ann = _ann(bbox_x=0.25, bbox_y=0.5, bbox_width=0.5, bbox_height=0.25)
    pixel = _annotation_bbox_pixel_xywh(ann, 800, 600)
    assert pixel == [200.0, 300.0, 400.0, 150.0]
