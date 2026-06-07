"""Tests for download_ultralytics_models ONNX skip logic."""

import os

from scripts.download_ultralytics_models import _should_export_auto_annotate_onnx


def test_skip_onnx_for_single_training_pt():
    assert _should_export_auto_annotate_onnx("yolov8n.pt") is False
    assert _should_export_auto_annotate_onnx("yolo11n-seg.pt") is False


def test_export_onnx_for_minimal_and_all():
    assert _should_export_auto_annotate_onnx("minimal") is True
    assert _should_export_auto_annotate_onnx("all") is True
    assert _should_export_auto_annotate_onnx("yolo11") is True


def test_skip_onnx_for_none_and_env(monkeypatch):
    assert _should_export_auto_annotate_onnx("none") is False
    monkeypatch.setenv("LAI_SKIP_AUTO_ANNOTATE_ONNX", "1")
    assert _should_export_auto_annotate_onnx("minimal") is False


def test_export_onnx_for_comma_list():
    assert _should_export_auto_annotate_onnx("yolov8n.pt,yolo11n.pt") is True
