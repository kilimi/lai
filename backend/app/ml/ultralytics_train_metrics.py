"""Extract per-epoch metrics from an Ultralytics trainer for the training UI."""
from __future__ import annotations

import json
import re
from typing import Any, Dict, Optional

LAI_METRICS_PREFIX = "LAI_METRICS "


def _loss_values_sequence(loss_items) -> list[float]:
    """Normalize trainer.loss_items (list, 1-d tensor, or 0-d scalar for classify)."""
    if loss_items is None:
        return []
    try:
        import torch

        if isinstance(loss_items, torch.Tensor):
            if loss_items.dim() == 0:
                return [float(loss_items.item())]
            flat = loss_items.detach().flatten()
            return [float(x) for x in flat.tolist()]
    except ImportError:
        pass
    if isinstance(loss_items, (int, float)):
        return [float(loss_items)]
    try:
        return [float(x) for x in loss_items]
    except TypeError:
        return []


def extract_trainer_epoch_metrics(trainer) -> Dict[str, Any]:
    """Build a JSON-serializable metrics dict from the Ultralytics trainer."""
    epoch = int(getattr(trainer, "epoch", 0)) + 1
    metrics: Dict[str, Any] = {"epoch": epoch}

    loss_items = getattr(trainer, "loss_items", None)
    loss_values = _loss_values_sequence(loss_items)
    if loss_values:
        names = list(getattr(trainer, "loss_names", None) or [])
        if not names:
            model_arg = ""
            args = getattr(trainer, "args", None)
            if args is not None:
                model_arg = str(getattr(args, "model", "") or "").lower()
            task = str(getattr(args, "task", "") or "").lower() if args is not None else ""
            if task == "classify" or "-cls" in model_arg or loss_values and len(loss_values) == 1:
                names = ["loss"]
            elif "seg" in model_arg:
                names = ["box_loss", "seg_loss", "cls_loss", "dfl_loss"]
            else:
                names = ["box_loss", "cls_loss", "dfl_loss"]
        for i, raw_name in enumerate(names):
            if i >= len(loss_values):
                break
            key = _normalize_loss_key(str(raw_name))
            try:
                val = loss_values[i]
                if val == val and abs(val) != float("inf"):
                    metrics[key] = val
            except (TypeError, ValueError):
                continue

    raw_metrics = getattr(trainer, "metrics", None)
    if raw_metrics is not None:
        if hasattr(raw_metrics, "results_dict"):
            try:
                rd = raw_metrics.results_dict
                if callable(rd):
                    rd = rd()
            except Exception:
                rd = None
            if isinstance(rd, dict):
                raw_metrics = rd
        if isinstance(raw_metrics, dict):
            for key, value in raw_metrics.items():
                mapped = _map_results_dict_key(str(key))
                if mapped and mapped not in metrics:
                    try:
                        fv = float(value)
                        if fv == fv and abs(fv) != float("inf"):
                            metrics[mapped] = fv
                    except (TypeError, ValueError):
                        continue

    optimizer = getattr(trainer, "optimizer", None)
    if optimizer is not None and hasattr(optimizer, "param_groups"):
        for i, group in enumerate(optimizer.param_groups[:3]):
            try:
                metrics[f"lr{i}"] = float(group.get("lr", 0.0))
            except (TypeError, ValueError):
                pass

    return metrics


def emit_trainer_epoch_metrics(trainer) -> None:
    """Print one line the Celery parent parses (flush for pipe streaming)."""
    payload = extract_trainer_epoch_metrics(trainer)
    if payload.get("epoch") is None:
        return
    print(f"{LAI_METRICS_PREFIX}{json.dumps(payload)}", flush=True)


def parse_lai_metrics_line(line: str) -> Optional[Dict[str, Any]]:
    if not line.startswith(LAI_METRICS_PREFIX):
        return None
    try:
        data = json.loads(line[len(LAI_METRICS_PREFIX) :])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _normalize_loss_key(name: str) -> str:
    lowered = name.lower().replace("/", "_").replace(" ", "_")
    if "box" in lowered:
        return "box_loss"
    if "seg" in lowered:
        return "seg_loss"
    if "cls" in lowered or "class" in lowered:
        return "cls_loss"
    if "dfl" in lowered:
        return "dfl_loss"
    if lowered.endswith("_loss"):
        return lowered
    return f"{lowered}_loss" if lowered else "loss"


def _map_results_dict_key(key: str) -> Optional[str]:
    k = key.lower()
    if "map50-95" in k or "map_50_95" in k or k.endswith("map50-95(b)"):
        return "mAP50_95"
    if "map50" in k and "95" not in k:
        return "mAP50"
    if "precision" in k:
        return "precision"
    if "recall" in k:
        return "recall"
    if "top1" in k:
        return "top1_acc"
    if "top5" in k:
        return "top5_acc"
    if re.search(r"train[/_.]box", k):
        return "box_loss"
    if re.search(r"train[/_.]cls", k):
        return "cls_loss"
    if re.search(r"train[/_.]dfl", k):
        return "dfl_loss"
    if re.search(r"train[/_.]seg", k):
        return "seg_loss"
    return None
