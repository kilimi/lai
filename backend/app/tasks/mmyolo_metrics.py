"""Parse MMYOLO / MMEngine training log lines into GUI-friendly metrics."""
import re
from typing import Any, Dict, Optional

# Epoch(train)  [10][1/1]  base_lr: 1.0000e-02 lr: 8.8396e-05 ... loss: 28.7061  loss_cls: 9.0565  loss_bbox: 11.2863  loss_dfl: 8.3633
TRAIN_EPOCH_RE = re.compile(
    r"Epoch\(train\)\s+\[(\d+)\].*?"
    r"\s+lr:\s*([\d.eE+-]+).*?"
    r"loss:\s*([\d.]+)\s+"
    r"loss_cls:\s*([\d.]+)\s+"
    r"loss_bbox:\s*([\d.]+)\s+"
    r"loss_dfl:\s*([\d.]+)"
)

# Epoch(val) [10][1/1]  coco/bbox_mAP: 0.123  coco/bbox_mAP_50: 0.456  ...
# Different MMYOLO/COCO hooks sometimes log keys as:
#   - coco/bbox_mAP, coco/bbox_mAP_50
#   - coco/mAP, coco/mAP_50
# so we accept optional "bbox_" and both forms.
VAL_MAP50_RE = re.compile(r"(?:coco/)?(?:bbox_)?mAP_50[:\s]*([\d.]+)")
VAL_MAP5095_RE = re.compile(r"(?:coco/)?(?:bbox_)?mAP(?:_50_95)?[:\s]*([\d.]+)")
VAL_PRECISION_RE = re.compile(r"(?:coco/)?(?:bbox_)?precision[:\s]*([\d.]+)")
VAL_RECALL_RE = re.compile(r"(?:coco/)?(?:bbox_)?recall[:\s]*([\d.]+)")


def parse_mmyolo_log_line(line: str) -> Optional[Dict[str, Any]]:
    """
    Parse a single MMYOLO log line into metric updates.

    Returns a dict with at least ``epoch`` when matched, or None.
    """
    train_match = TRAIN_EPOCH_RE.search(line)
    if train_match:
        epoch = int(train_match.group(1))
        lr = float(train_match.group(2))
        return {
            "epoch": epoch,
            "cls_loss": float(train_match.group(4)),
            "box_loss": float(train_match.group(5)),
            "dfl_loss": float(train_match.group(6)),
            "lr0": lr,
        }

    if "Epoch(val)" not in line:
        return None

    val_match = re.search(r"Epoch\(val\)\s+\[(\d+)\]", line)
    if not val_match:
        return None

    metrics: Dict[str, Any] = {"epoch": int(val_match.group(1))}

    map50_match = VAL_MAP50_RE.search(line)
    if map50_match:
        metrics["mAP50"] = float(map50_match.group(1))

    map_match = VAL_MAP5095_RE.search(line)
    if map_match:
        metrics["mAP50_95"] = float(map_match.group(1))

    prec_match = VAL_PRECISION_RE.search(line)
    if prec_match:
        metrics["precision"] = float(prec_match.group(1))

    recall_match = VAL_RECALL_RE.search(line)
    if recall_match:
        metrics["recall"] = float(recall_match.group(1))

    if len(metrics) <= 1:
        return None
    return metrics


def merge_epoch_metrics(
    history: list,
    parsed: Dict[str, Any],
) -> tuple[list, Dict[str, Any]]:
    """Merge parsed log metrics into per-epoch history used by the GUI charts."""
    epoch = parsed.get("epoch")
    if epoch is None:
        return history, parsed

    updated = list(history)
    existing_idx = next((i for i, m in enumerate(updated) if m.get("epoch") == epoch), None)

    if existing_idx is not None:
        merged = {**updated[existing_idx], **parsed}
        updated[existing_idx] = merged
    else:
        updated.append(dict(parsed))
        updated.sort(key=lambda m: m.get("epoch", 0))

    latest = pick_latest_display_metrics(updated)
    return updated, latest


def pick_latest_display_metrics(history: list) -> Dict[str, Any]:
    """
    Build the metrics snapshot shown in the GUI.

    Train logs arrive every epoch; validation mAP is logged less often. Keep the
    most recent validation mAP on the latest row so hero tiles do not blank out
    between val runs.
    """
    if not history:
        return {}

    latest_train = history[-1]
    latest_val = next(
        (m for m in reversed(history) if m.get("mAP50") is not None or m.get("mAP50_95") is not None),
        None,
    )

    merged = dict(latest_train)
    if latest_val:
        if latest_val.get("mAP50") is not None:
            merged["mAP50"] = latest_val["mAP50"]
        if latest_val.get("mAP50_95") is not None:
            merged["mAP50_95"] = latest_val["mAP50_95"]
        if latest_val.get("precision") is not None:
            merged["precision"] = latest_val["precision"]
        if latest_val.get("recall") is not None:
            merged["recall"] = latest_val["recall"]

    if merged.get("epoch") is None and latest_val and latest_val.get("epoch") is not None:
        merged["epoch"] = latest_val["epoch"]

    return merged
