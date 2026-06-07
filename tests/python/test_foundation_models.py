"""Tests for foundation model matrix and install-time spec resolution."""

from app.foundation_models import (
    AUTO_ANNOTATE_YOLO_ONNX,
    AUTO_ANNOTATE_YOLO_BASE,
    ARCH_SIZES,
    DEPTH_ONNX_NAMES,
    MINIMAL_DEPTH_ONNX,
    MINIMAL_ULTRALYTICS_PT,
    auto_annotate_yolo_catalog,
    auto_annotate_yolo_onnx_name,
    pretrained_yolo_catalog,
    resolve_depth_models_spec,
    resolve_ultralytics_pretrained_spec,
    ultralytics_foundation_pt_names,
    validate_auto_annotate_yolo_model,
)


def test_arch_sizes_covers_training_families():
    archs = {a for a, _ in ARCH_SIZES}
    assert archs >= {"yolo11", "yolo26", "rtdetr"}


def test_ultralytics_names_include_yolo11_and_rtdetr_variants():
    names = ultralytics_foundation_pt_names()
    assert "rtdetrl.pt" in names
    assert "yolo11n-seg.pt" in names


def test_resolve_all_equals_full_matrix():
    full = ultralytics_foundation_pt_names()
    assert resolve_ultralytics_pretrained_spec("all") == sorted(full)
    assert resolve_ultralytics_pretrained_spec("") == sorted(full)


def test_resolve_none_skips_baked_weights():
    assert resolve_ultralytics_pretrained_spec("none") == []
    assert resolve_ultralytics_pretrained_spec("on_demand") == []
    assert resolve_depth_models_spec("none") == []
    assert resolve_depth_models_spec("on_demand") == []


def test_resolve_minimal_subset():
    r = resolve_ultralytics_pretrained_spec("minimal")
    assert set(r) == set(MINIMAL_ULTRALYTICS_PT)
    assert len(r) == len(MINIMAL_ULTRALYTICS_PT)


def test_resolve_arch_token_yolo11():
    r = resolve_ultralytics_pretrained_spec("yolo11")
    assert all(n.startswith("yolo11") for n in r)
    assert "yolo26n.pt" not in r


def test_resolve_comma_archs():
    r = resolve_ultralytics_pretrained_spec("yolo11,rtdetr")
    assert all(n.startswith("yolo11") or n.startswith("rtdetr") for n in r)
    assert "yolo26n.pt" not in r


def test_unknown_arch_token_ignored():
    """Overly short tokens like 'yolo' must not match every architecture."""
    r = resolve_ultralytics_pretrained_spec("yolo")
    assert r == sorted(MINIMAL_ULTRALYTICS_PT)


def test_resolve_exact_pt_files():
    r = resolve_ultralytics_pretrained_spec("yolo11n.pt,yolo26m-seg.pt")
    assert r == ["yolo11n.pt", "yolo26m-seg.pt"]


def test_auto_annotate_catalog_yolo11m_onnx_only():
    cat = pretrained_yolo_catalog()
    assert set(cat.keys()) == set(AUTO_ANNOTATE_YOLO_ONNX)
    assert cat["yolo11m-seg.onnx"]["type"] == "segmentation"
    assert cat["yolo11m.onnx"]["type"] == "detection"
    assert cat["yolo11m-cls.onnx"]["type"] == "classification"
    assert cat["yolo11m.onnx"]["name"] == AUTO_ANNOTATE_YOLO_BASE


def test_auto_annotate_onnx_name_by_task():
    assert auto_annotate_yolo_onnx_name("detect") == "yolo11m.onnx"
    assert auto_annotate_yolo_onnx_name("segment") == "yolo11m-seg.onnx"
    assert auto_annotate_yolo_onnx_name("classify") == "yolo11m-cls.onnx"


def test_validate_auto_annotate_rejects_other_models():
    validate_auto_annotate_yolo_model("yolo11m", "detect")
    try:
        validate_auto_annotate_yolo_model("yolo11n", "detect")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_depth_spec_all_and_minimal():
    assert resolve_depth_models_spec("all") == list(DEPTH_ONNX_NAMES)
    assert resolve_depth_models_spec("minimal") == list(MINIMAL_DEPTH_ONNX)


def test_depth_spec_exact_files():
    one = "depth_anything_v2_vitb_outdoor_dynamic.onnx"
    assert resolve_depth_models_spec(one) == [one]
