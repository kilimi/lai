"""Tests for FiftyOne evaluation ground-truth bbox normalization."""
from app.services.predictions_service import (
    _fiftyone_bbox_normalized_from_xyxy_pixel,
    _match_training_class_name,
)


def test_xyxy_pixel_to_fiftyone_normalized():
    bbox = _fiftyone_bbox_normalized_from_xyxy_pixel([10, 20, 50, 80], 200, 100)
    assert bbox == [0.05, 0.2, 0.2, 0.6]


def test_match_training_class_name_case_insensitive():
    names = ["Car", "Truck", "background"]
    assert _match_training_class_name(names, "car") == "Car"
    assert _match_training_class_name(names, "truck") == "Truck"
    assert _match_training_class_name(names, "bus") == "bus"
