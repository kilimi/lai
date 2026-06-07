"""Parse Ultralytics YOLO training logs and results.csv for the GUI."""
from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.tasks.mmyolo_metrics import merge_epoch_metrics, pick_latest_display_metrics

# Epoch progress: "     95/100      1.55G       1.16      1.272     0.8763 ..." (3 or 4 losses)
TRAIN_EPOCH_RE = re.compile(
    r"^\s*(\d+)/(\d+)\s+\S+\s+((?:[\d.eE+-]+\s+){3,})"
)

# Validation summary: first four floats after Images/Instances are box P, R, mAP50, mAP50-95
VAL_ALL_RE = re.compile(
    r"^\s*all\s+\d+\s+\d+\s+((?:[\d.eE+-]+\s*){4,})"
)

_FLOAT_RE = re.compile(r"[\d.eE+-]+")

CUDA_DEVICE_RE = re.compile(
    r"torch-[\d.]+\+?\S*\s+CUDA:(\S+)\s*\(([^,)]+)",
    re.IGNORECASE,
)


def parse_ultralytics_train_line(line: str) -> Optional[Dict[str, Any]]:
    m = TRAIN_EPOCH_RE.match(line.strip())
    if not m:
        return None
    floats = [float(x) for x in _FLOAT_RE.findall(m.group(3))]
    if len(floats) < 3:
        return None
    out: Dict[str, Any] = {"epoch": int(m.group(1))}
    if len(floats) >= 4:
        out["box_loss"] = floats[0]
        out["seg_loss"] = floats[1]
        out["cls_loss"] = floats[2]
        out["dfl_loss"] = floats[3]
    else:
        out["box_loss"] = floats[0]
        out["cls_loss"] = floats[1]
        out["dfl_loss"] = floats[2]
    return out


def parse_ultralytics_val_line(line: str, epoch: int) -> Optional[Dict[str, Any]]:
    m = VAL_ALL_RE.match(line.strip())
    if not m or epoch <= 0:
        return None
    floats = [float(x) for x in _FLOAT_RE.findall(m.group(1))]
    if len(floats) < 4:
        return None
    return {
        "epoch": epoch,
        "precision": floats[0],
        "recall": floats[1],
        "mAP50": floats[2],
        "mAP50_95": floats[3],
    }


def parse_ultralytics_device_line(line: str) -> Optional[str]:
    m = CUDA_DEVICE_RE.search(line)
    if not m:
        return None
    device_id = m.group(1).strip()
    gpu_name = m.group(2).strip()
    return f"cuda:{device_id} ({gpu_name})"


def load_metrics_from_results_csv(csv_path: Path) -> List[Dict[str, Any]]:
    """Load per-epoch metrics from Ultralytics results.csv."""
    if not csv_path.is_file():
        return []

    history: List[Dict[str, Any]] = []
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                epoch = int(float(row.get("epoch", "") or 0))
            except (TypeError, ValueError):
                continue
            if epoch <= 0:
                continue

            def _f(key: str) -> Optional[float]:
                raw = row.get(key)
                if raw is None or raw == "":
                    return None
                try:
                    v = float(raw)
                    return v if v == v else None
                except (TypeError, ValueError):
                    return None

            entry: Dict[str, Any] = {"epoch": epoch}
            column_map = (
                ("train/box_loss", "box_loss"),
                ("train/seg_loss", "seg_loss"),
                ("train/cls_loss", "cls_loss"),
                ("train/dfl_loss", "dfl_loss"),
                ("metrics/precision(B)", "precision"),
                ("metrics/recall(B)", "recall"),
                ("metrics/mAP50(B)", "mAP50"),
                ("metrics/mAP50-95(B)", "mAP50_95"),
                ("metrics/precision(M)", "precision"),
                ("metrics/recall(M)", "recall"),
                ("metrics/mAP50(M)", "mAP50"),
                ("metrics/mAP50-95(M)", "mAP50_95"),
            )
            for src, dst in column_map:
                if dst in entry and dst.startswith("mAP"):
                    continue
                if dst in ("precision", "recall") and dst in entry:
                    continue
                val = _f(src)
                if val is not None:
                    entry[dst] = val
            if len(entry) > 1:
                history.append(entry)

    history.sort(key=lambda m: m.get("epoch", 0))
    return history


def finalize_yolo_metrics(
    history: List[Dict[str, Any]],
    *,
    results_csv: Optional[Path] = None,
) -> tuple[List[Dict[str, Any]], Dict[str, Any], Dict[str, Any]]:
    """
    Prefer results.csv when available (complete history); merge with streamed log metrics.
    """
    csv_history = load_metrics_from_results_csv(results_csv) if results_csv else []
    if csv_history:
        merged = csv_history
    elif history:
        merged = list(history)
    else:
        merged = []

    latest = pick_latest_display_metrics(merged)
    summary: Dict[str, Any] = {}
    if latest:
        for key in ("mAP50", "mAP50_95", "precision", "recall", "box_loss", "cls_loss", "dfl_loss"):
            if latest.get(key) is not None:
                summary[key] = latest[key]

    return merged, latest, summary
