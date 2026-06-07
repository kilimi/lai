"""Tests for Ultralytics 8.4+ lazy export compatibility patch."""
from app.ml.ultralytics_compat import (
    assert_ultralytics_supports_model,
    model_type_requires_yolo26,
    patch_matplotlib_for_headless,
    patch_ultralytics_lazy_exports,
)


def test_model_type_requires_yolo26():
    assert model_type_requires_yolo26("yolo26m.pt")
    assert model_type_requires_yolo26("/app/models/yolo26n-seg.pt")
    assert not model_type_requires_yolo26("yolo11m.pt")


def test_assert_ultralytics_supports_model_skips_non_yolo26():
    assert_ultralytics_supports_model("yolo11m.pt")


def test_patch_ultralytics_lazy_exports_idempotent():
    patch_ultralytics_lazy_exports()
    patch_ultralytics_lazy_exports()

    try:
        import ultralytics
    except Exception:
        return  # ultralytics not installed in this test env

    # After patch, direct import must work (required by ultralytics check_amp).
    from ultralytics import YOLO  # noqa: F401

    assert getattr(ultralytics, "YOLO", None) is not None


def test_patch_matplotlib_for_headless_skips_broken_fonts(tmp_path):
    patch_matplotlib_for_headless()
    patch_matplotlib_for_headless()

    try:
        from matplotlib import font_manager
    except ImportError:
        return

    broken_font = tmp_path / "broken.ttf"
    broken_font.write_bytes(b"not-a-valid-font")
    font_manager.fontManager.addfont(str(broken_font))
