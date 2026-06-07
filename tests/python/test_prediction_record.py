"""Tests for PredictionRecord normalization."""
from __future__ import annotations

from app.ml.predictions import from_mmyolo_dict, to_eval_dicts
from app.ml.schemas import PredictionRecord


def test_from_mmyolo_dict_xywh_and_xyxy():
    raw = {
        "image_id": 42,
        "class_id": 1,
        "bbox": [10.0, 20.0, 30.0, 40.0],
        "bbox_xyxy": [10.0, 20.0, 40.0, 60.0],
        "conf": 0.91,
        "segmentation": [],
    }
    rec = from_mmyolo_dict(raw)
    assert rec.image_id == 42
    assert rec.class_id == 1
    assert rec.conf == 0.91
    assert rec.bbox_xywh == [10.0, 20.0, 30.0, 40.0]
    assert rec.bbox_xyxy == [10.0, 20.0, 40.0, 60.0]


def test_from_mmyolo_dict_derives_xyxy_from_xywh():
    raw = {
        "image_id": 1,
        "class_id": 0,
        "bbox": [5.0, 10.0, 20.0, 30.0],
        "conf": 0.5,
    }
    rec = from_mmyolo_dict(raw)
    assert rec.bbox_xyxy == [5.0, 10.0, 25.0, 40.0]


def test_prediction_record_to_eval_dict():
    rec = PredictionRecord(
        image_id=7,
        class_id=2,
        conf=0.88,
        bbox_xywh=[1.0, 2.0, 3.0, 4.0],
        bbox_xyxy=[1.0, 2.0, 4.0, 6.0],
        segmentation=[[0.0, 0.0], [1.0, 1.0]],
    )
    d = rec.to_eval_dict()
    assert d["image_id"] == 7
    assert d["class_id"] == 2
    assert d["bbox"] == [1.0, 2.0, 3.0, 4.0]
    assert d["bbox_xyxy"] == [1.0, 2.0, 4.0, 6.0]
    assert d["conf"] == 0.88
    assert len(d["segmentation"]) == 2


def test_to_eval_dicts_batch():
    records = [
        PredictionRecord(image_id=1, class_id=0, conf=0.9, bbox_xywh=[0, 0, 10, 10]),
        PredictionRecord(image_id=2, class_id=1, conf=0.8, bbox_xywh=[1, 1, 5, 5]),
    ]
    out = to_eval_dicts(records)
    assert len(out) == 2
    assert out[0]["image_id"] == 1
