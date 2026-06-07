"""Tests for YOLOv8 → MMYOLO weight key remapping."""

from app.ml.mmyolo_yolov8_convert import remap_yolov8_state_dict


def test_remap_yolov8_backbone_stem():
    blobs = {"model.0.conv.weight": object()}
    out = remap_yolov8_state_dict(blobs)
    assert "backbone.stem.conv.weight" in out


def test_remap_yolov8_head_drops_dfl_conv_weight():
    blobs = {
        "model.22.cv2.0.conv.weight": object(),
        "model.22.dfl.conv.weight": object(),
    }
    out = remap_yolov8_state_dict(blobs)
    assert any(k.startswith("bbox_head.head_module.reg_preds") for k in out)
    assert "bbox_head.head_module.dfl.conv.weight" not in out


def test_remap_yolov8_csp_block_cv_to_conv():
    blobs = {"model.2.m.0.cv1.conv.weight": object()}
    out = remap_yolov8_state_dict(blobs)
    assert "backbone.stage1.1.blocks.0.conv1.conv.weight" in out
