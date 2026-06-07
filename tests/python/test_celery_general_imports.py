"""General Celery app must not import ultralytics or mmyolo at startup."""
import sys

import pytest


@pytest.fixture(autouse=True)
def _clear_ml_modules():
    for key in list(sys.modules):
        if key == "ultralytics" or key.startswith("ultralytics."):
            sys.modules.pop(key, None)
        if key == "mmyolo" or key.startswith("mmyolo."):
            sys.modules.pop(key, None)
    yield


def test_general_app_import_without_ultralytics():
    # Import twice to ensure task modules load (use import_module — app.celery
    # package shadows general_app with the Celery instance).
    import importlib

    ga = importlib.import_module("app.celery.general_app")
    importlib.reload(ga)
    assert "ultralytics" not in sys.modules
    assert "mmyolo" not in sys.modules


def test_gpu_app_is_separate_instance():
    from app.celery.general_app import celery_app as general
    from app.celery.gpu_app import celery_app as gpu

    assert general.main != gpu.main
