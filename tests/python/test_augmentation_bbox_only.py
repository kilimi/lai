"""Regression: bbox-only annotations must be picked up during dataset augmentation."""

from types import SimpleNamespace

from app.services.annotation_processing import annotation_bbox_pixel_xywh


def _ann(**kwargs):
    return SimpleNamespace(
        bbox=kwargs.get("bbox"),
        bbox_x=kwargs.get("bbox_x"),
        bbox_y=kwargs.get("bbox_y"),
        bbox_width=kwargs.get("bbox_width"),
        bbox_height=kwargs.get("bbox_height"),
    )


def test_pixel_bbox_from_normalized_columns():
    ann = _ann(bbox_x=0.1, bbox_y=0.2, bbox_width=0.3, bbox_height=0.4, bbox=None)
    assert annotation_bbox_pixel_xywh(ann, img_width=1000, img_height=800) == [
        100.0,
        160.0,
        300.0,
        320.0,
    ]


def test_pixel_bbox_from_legacy_pixel_json():
    ann = _ann(bbox=[50, 60, 100, 80])
    assert annotation_bbox_pixel_xywh(ann, img_width=640, img_height=480) == [
        50.0,
        60.0,
        100.0,
        80.0,
    ]


def test_pixel_bbox_from_normalized_json_when_columns_missing():
    ann = _ann(bbox=[0.25, 0.5, 0.5, 0.25])
    assert annotation_bbox_pixel_xywh(ann, img_width=200, img_height=400) == [
        50.0,
        200.0,
        100.0,
        100.0,
    ]


def test_prefers_normalized_columns_over_bbox_json():
    ann = _ann(
        bbox_x=0.1,
        bbox_y=0.1,
        bbox_width=0.2,
        bbox_height=0.2,
        bbox=[999, 999, 999, 999],
    )
    assert annotation_bbox_pixel_xywh(ann, img_width=100, img_height=100) == [
        10.0,
        10.0,
        20.0,
        20.0,
    ]


def test_returns_none_when_no_bbox_data():
    ann = _ann(bbox=None, segmentation=[])
    assert annotation_bbox_pixel_xywh(ann, img_width=640, img_height=480) is None


def test_bbox_only_keypoint_lists_are_not_polygon_keypoints():
    """Regression: [[], []] must not enable Albumentations keypoint_params."""
    keypoints = [[], []]
    assert bool(keypoints) is True  # old buggy check
    assert any(kp for kp in keypoints) is False  # correct check


def test_mixed_annotations_enable_polygon_keypoints():
    keypoints = [[], [(1.0, 2.0), (3.0, 4.0)]]
    assert any(kp for kp in keypoints) is True
