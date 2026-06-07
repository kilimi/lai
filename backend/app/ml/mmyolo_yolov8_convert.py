"""Convert Ultralytics YOLOv8 .pt weights to MMYOLO checkpoint format.

Adapted from ``/opt/mmyolo/tools/model_converters/yolov8_to_mmyolo.py`` so we can
load checkpoints via the Ultralytics pip package (worker-gpu) instead of copying
the script into the upstream Ultralytics git repo.
"""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Mapping

# Same layer mapping as MMYOLO's yolov8_to_mmyolo.py (all YOLOv8 n/s/m/l/x sizes).
YOLOV8_LAYER_MAP: dict[str, str] = {
    "model.0": "backbone.stem",
    "model.1": "backbone.stage1.0",
    "model.2": "backbone.stage1.1",
    "model.3": "backbone.stage2.0",
    "model.4": "backbone.stage2.1",
    "model.5": "backbone.stage3.0",
    "model.6": "backbone.stage3.1",
    "model.7": "backbone.stage4.0",
    "model.8": "backbone.stage4.1",
    "model.9": "backbone.stage4.2",
    "model.12": "neck.top_down_layers.0",
    "model.15": "neck.top_down_layers.1",
    "model.16": "neck.downsample_layers.0",
    "model.18": "neck.bottom_up_layers.0",
    "model.19": "neck.downsample_layers.1",
    "model.21": "neck.bottom_up_layers.1",
    "model.22": "bbox_head.head_module",
}

YOLOV8_ALIAS_TO_ULTRALYTICS_PT: dict[str, str] = {
    "yolov8_n": "yolov8n.pt",
    "yolov8_s": "yolov8s.pt",
    "yolov8_m": "yolov8m.pt",
    "yolov8_l": "yolov8l.pt",
    "yolov8_x": "yolov8x.pt",
}

MMYOLO_YOLOV8_CONVERT_SCRIPT = Path(
    "/opt/mmyolo/tools/model_converters/yolov8_to_mmyolo.py"
)


def remap_yolov8_state_dict(blobs: Mapping[str, object]) -> OrderedDict:
    """Remap Ultralytics YOLOv8 keys to MMYOLO module names."""
    state_dict: OrderedDict[str, object] = OrderedDict()
    for key, weight in blobs.items():
        parts = key.split(".")
        if len(parts) < 3 or parts[0] != "model":
            continue
        prefix = f"model.{parts[1]}"
        target_prefix = YOLOV8_LAYER_MAP.get(prefix)
        if target_prefix is None:
            continue
        new_key = key.replace(prefix, target_prefix, 1)

        if ".m." in new_key:
            new_key = new_key.replace(".m.", ".blocks.")
            new_key = new_key.replace(".cv", ".conv")
        elif "bbox_head.head_module.proto.cv" in new_key:
            new_key = new_key.replace(
                "bbox_head.head_module.proto.cv",
                "bbox_head.head_module.proto_preds.conv",
            )
        elif "bbox_head.head_module.proto" in new_key:
            new_key = new_key.replace(
                "bbox_head.head_module.proto", "bbox_head.head_module.proto_preds"
            )
        elif "bbox_head.head_module.cv4." in new_key:
            new_key = new_key.replace(
                "bbox_head.head_module.cv4", "bbox_head.head_module.mask_coeff_preds"
            )
            new_key = new_key.replace(".2.weight", ".2.conv.weight")
            new_key = new_key.replace(".2.bias", ".2.conv.bias")
        elif "bbox_head.head_module" in new_key:
            new_key = new_key.replace(".cv2", ".reg_preds")
            new_key = new_key.replace(".cv3", ".cls_preds")
        elif "backbone.stage4.2" in new_key:
            new_key = new_key.replace(".cv", ".conv")
        else:
            new_key = new_key.replace(".cv1", ".main_conv")
            new_key = new_key.replace(".cv2", ".final_conv")

        if new_key == "bbox_head.head_module.dfl.conv.weight":
            continue
        state_dict[new_key] = weight
    return state_dict


def load_ultralytics_yolov8_state_dict(pt_path: Path) -> OrderedDict:
    """Load a YOLOv8 detection checkpoint via Ultralytics."""
    from app.ml.runtime_env import ensure_ultralytics_sys_path

    ensure_ultralytics_sys_path()
    from ultralytics import YOLO

    model = YOLO(str(pt_path))
    inner = getattr(model, "model", None)
    if inner is None:
        raise RuntimeError(f"Ultralytics model has no .model for {pt_path}")
    return inner.state_dict()


def convert_yolov8_ultralytics_pt_to_mmyolo(src: Path, dst: Path) -> Path:
    """Convert ``yolov8s.pt`` (etc.) to an MMYOLO ``state_dict`` checkpoint."""
    import torch

    blobs = load_ultralytics_yolov8_state_dict(src)
    state_dict = remap_yolov8_state_dict(blobs)
    if not state_dict:
        raise RuntimeError(f"No YOLOv8 layers matched after loading {src}")

    dst.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": state_dict}, dst)
    return dst
