"""Smoke imports for service layer and thin routers (post-refactor)."""
from __future__ import annotations

import importlib

import pytest

SERVICE_MODULES = [
    "app.services.dataset_schemas",
    "app.services.dataset_paths",
    "app.services.dataset_media_service",
    "app.services.dataset_video_service",
    "app.services.dataset_images_service",
    "app.services.dataset_video_extract_service",
    "app.services.dataset_annotations_service",
    "app.services.dataset_annotation_merge_service",
    "app.services.dataset_fiftyone_service",
    "app.services.dataset_service",
    "app.services.annotation_processing",
    "app.services.training_schemas",
    "app.services.training_operations_service",
    "app.services.predictions_service",
]

ROUTER_MODULES = [
    "app.routers.datasets",
    "app.routers.annotation_db",
    "app.routers.training",
    "app.routers.predictions",
]


@pytest.mark.parametrize("module_name", SERVICE_MODULES)
def test_service_module_imports(module_name: str) -> None:
    mod = importlib.import_module(module_name)
    assert mod is not None


@pytest.mark.parametrize("module_name", ROUTER_MODULES)
def test_router_module_imports(module_name: str) -> None:
    mod = importlib.import_module(module_name)
    assert hasattr(mod, "router")


def test_annotation_processing_exports() -> None:
    from app.services import annotation_processing as ap

    assert callable(ap.detect_annotation_type)
    assert callable(ap.process_coco_annotation_file)


def test_predictions_service_helpers() -> None:
    from app.services.predictions_service import build_thresholded_evaluation_coco_bundle

    assert callable(build_thresholded_evaluation_coco_bundle)
