"""Tests for Ultralytics YOLO metrics parsing."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.tasks.yolo_metrics import (
    finalize_yolo_metrics,
    load_metrics_from_results_csv,
    parse_ultralytics_device_line,
    parse_ultralytics_train_line,
    parse_ultralytics_val_line,
)


def test_parse_val_line():
    line = "                   all          2         43      0.606      0.179        0.3       0.15"
    m = parse_ultralytics_val_line(line, 10)
    assert m is not None
    assert m["epoch"] == 10
    assert m["mAP50"] == 0.3
    assert m["mAP50_95"] == 0.15


def test_parse_val_line_scientific_and_seg_extra_columns():
    line = (
        "                   all         19         75        0.5    0.00746   9.44e-05   "
        "5.62e-05      0.501    0.00746    0.00108   0.000508"
    )
    m = parse_ultralytics_val_line(line, 5)
    assert m is not None
    assert m["precision"] == 0.5
    assert m["mAP50"] == pytest.approx(9.44e-05)
    assert m["mAP50_95"] == pytest.approx(5.62e-05)


def test_parse_train_line_seg_four_losses():
    line = "     1/1000      4.68G      1.775      3.227      14.09      1.145          9       1280: 100%"
    m = parse_ultralytics_train_line(line)
    assert m is not None
    assert m["box_loss"] == 1.775
    assert m["seg_loss"] == 3.227
    assert m["cls_loss"] == 14.09
    assert m["dfl_loss"] == 1.145


def test_parse_cuda_device_line():
    line = (
        "Ultralytics 8.4.10 Python-3.10.13 torch-2.1.0 CUDA:0 "
        "(NVIDIA GeForce GTX 1070 with Max-Q Design, 8114MiB)"
    )
    assert parse_ultralytics_device_line(line) == (
        "cuda:0 (NVIDIA GeForce GTX 1070 with Max-Q Design)"
    )


def test_load_results_csv(tmp_path: Path):
    csv_path = tmp_path / "results.csv"
    csv_path.write_text(
        "epoch,train/box_loss,metrics/mAP50(B),metrics/mAP50-95(B)\n"
        "1,1.5,0.1,0.05\n"
        "2,1.2,0.3,0.15\n",
        encoding="utf-8",
    )
    hist = load_metrics_from_results_csv(csv_path)
    assert len(hist) == 2
    assert hist[-1]["mAP50"] == 0.3

    merged, latest, summary = finalize_yolo_metrics([], results_csv=csv_path)
    assert len(merged) == 2
    assert latest["mAP50"] == 0.3
    assert summary["mAP50"] == 0.3
