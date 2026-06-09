"""Tests for YOLO auto-annotation coordinate helpers."""
from app.tasks.auto_annotation_tasks import xyxy_to_normalized_bbox


def test_xyxy_to_normalized_bbox_centers_on_image():
    bbox, area = xyxy_to_normalized_bbox(100, 50, 300, 250, 1000, 500)
    assert bbox == [0.1, 0.1, 0.2, 0.4]
    assert abs(area - 0.08) < 1e-9


def test_xyxy_to_normalized_bbox_handles_small_images():
    bbox, area = xyxy_to_normalized_bbox(0, 0, 10, 10, 10, 10)
    assert bbox == [0.0, 0.0, 1.0, 1.0]
    assert abs(area - 1.0) < 1e-9
