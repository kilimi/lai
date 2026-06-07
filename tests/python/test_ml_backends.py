"""Tests for registered ML backends (no GPU / heavy deps)."""
from __future__ import annotations

import pytest

from app.ml.registry import celery_queue_for_backend, clear_registry, get_backend, list_backends
from app.ml.schemas import VisionTask


@pytest.fixture(autouse=True)
def _register_backends():
    clear_registry()
    from app.ml.backends import register_all_backends

    register_all_backends()
    yield
    clear_registry()


def test_backends_registered():
  ids = {b.id for b in list_backends()}
  assert "ultralytics.yolo" in ids
  assert "ultralytics.rtdetr" in ids
  assert "mmyolo" in ids


def test_ultralytics_validate_start_request():
  backend = get_backend("ultralytics.yolo")
  spec = backend.validate_start_request({"model_type": "yolo11n-seg.pt", "project_id": 1, "dataset_configs": []})
  assert spec.framework_id == "ultralytics.yolo"
  assert spec.task == VisionTask.SEGMENT


def test_mmyolo_validate_start_request():
  backend = get_backend("mmyolo")
  spec = backend.validate_start_request({
    "arch": "rtmdet",
    "size": "s",
    "task": "detect",
    "project_id": 1,
    "dataset_configs": [],
  })
  assert spec.framework_id == "mmyolo"
  assert "config_id" in spec.legacy_metadata


def test_ultralytics_catalog_has_variants():
  cat = get_backend("ultralytics.yolo").catalog()
  assert len(cat.variants) > 0
  assert cat.runtime_profile == "ultralytics"


def test_celery_queue_for_ultralytics_maps_to_gpu():
  assert celery_queue_for_backend(get_backend("ultralytics.yolo")) == "gpu"
  assert celery_queue_for_backend(get_backend("ultralytics.rtdetr")) == "gpu"


def test_celery_queue_for_mmyolo():
  assert celery_queue_for_backend(get_backend("mmyolo")) == "mmyolo"
