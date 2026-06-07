"""Annotation API returns normalized bboxes for grid overlay."""
from types import SimpleNamespace

from app.services.annotation_processing import annotation_bbox_normalized_xywh


def test_normalized_from_bbox_columns():
    ann = SimpleNamespace(
        bbox_x=0.1,
        bbox_y=0.2,
        bbox_width=0.3,
        bbox_height=0.4,
        bbox=[999, 999, 999, 999],
    )
    assert annotation_bbox_normalized_xywh(ann, img_width=960, img_height=540) == [
        0.1,
        0.2,
        0.3,
        0.4,
    ]


def test_normalized_from_pixel_coco_bbox_json():
    ann = SimpleNamespace(
        bbox_x=None,
        bbox_y=None,
        bbox_width=None,
        bbox_height=None,
        bbox=[96.0, 54.0, 192.0, 108.0],
    )
    out = annotation_bbox_normalized_xywh(ann, img_width=960, img_height=540)
    assert out is not None
    assert abs(out[0] - 0.1) < 1e-6
    assert abs(out[2] - 0.2) < 1e-6
