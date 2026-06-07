"""Tests for structured LAI_METRICS lines from the Ultralytics training subprocess."""
from __future__ import annotations

import json
from types import SimpleNamespace

from app.ml.ultralytics_train_metrics import (
    LAI_METRICS_PREFIX,
    extract_trainer_epoch_metrics,
    parse_lai_metrics_line,
)


def test_parse_lai_metrics_line():
    payload = {"epoch": 3, "box_loss": 1.2, "mAP50": 0.45, "mAP50_95": 0.22}
    line = LAI_METRICS_PREFIX + json.dumps(payload)
    parsed = parse_lai_metrics_line(line)
    assert parsed == payload


def test_parse_lai_metrics_line_invalid():
    assert parse_lai_metrics_line("not metrics") is None
    assert parse_lai_metrics_line(LAI_METRICS_PREFIX + "{bad") is None


def test_extract_trainer_epoch_metrics_classification_scalar_loss():
    try:
        import torch
    except ImportError:
        return

    trainer = SimpleNamespace(
        epoch=0,
        loss_items=torch.tensor(0.7438),
        loss_names=[],
        metrics={"metrics/top1_acc": 0.0, "metrics/top5_acc": 1.0},
        args=SimpleNamespace(model="yolo11n-cls.pt", task="classify"),
        optimizer=SimpleNamespace(param_groups=[{"lr": 0.01}]),
    )
    metrics = extract_trainer_epoch_metrics(trainer)
    assert metrics["epoch"] == 1
    assert abs(metrics["loss"] - 0.7438) < 1e-4
    assert metrics.get("top1_acc") == 0.0
    assert metrics.get("top5_acc") == 1.0
