"""YOLO shim compatibility."""
import pytest


def test_load_yolo_class_without_ultralytics(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "ultralytics", None)
    with pytest.raises((ImportError, TypeError, AttributeError)):
        from app.ml import yolo

        yolo.load_yolo_class()


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("ultralytics") is None,
    reason="ultralytics not installed in test environment",
)
def test_load_yolo_class_when_installed():
    from app.ml.yolo import load_yolo_class

    YOLO = load_yolo_class()
    assert YOLO is not None
