"""Tests for MMYOLO training log metric parsing."""
from app.tasks.mmyolo_metrics import (
    merge_epoch_metrics,
    parse_mmyolo_log_line,
    pick_latest_display_metrics,
)


def test_parse_train_line():
    line = (
        "Epoch(train)   [5][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
        "loss: 28.8379  loss_cls: 9.1619  loss_bbox: 11.2042  loss_dfl: 8.4718"
    )
    parsed = parse_mmyolo_log_line(line)
    assert parsed == {
        "epoch": 5,
        "cls_loss": 9.1619,
        "box_loss": 11.2042,
        "dfl_loss": 8.4718,
        "lr0": 0.0001,
    }


def test_parse_val_line():
    line = (
        "Epoch(val) [10][2/2]    coco/bbox_mAP: 0.1230  "
        "coco/bbox_mAP_50: 0.4560  coco/bbox_mAP_75: 0.0900"
    )
    parsed = parse_mmyolo_log_line(line)
    assert parsed == {"epoch": 10, "mAP50": 0.456, "mAP50_95": 0.123}


def test_pick_latest_display_metrics_keeps_map_between_val_runs():
    history = [
        {"epoch": 10, "cls_loss": 5.0, "box_loss": 4.0, "mAP50": 0.4, "mAP50_95": 0.2},
        {"epoch": 11, "cls_loss": 4.5, "box_loss": 3.8},
        {"epoch": 12, "cls_loss": 4.0, "box_loss": 3.5},
    ]
    latest = pick_latest_display_metrics(history)
    assert latest["epoch"] == 12
    assert latest["cls_loss"] == 4.0
    assert latest["mAP50"] == 0.4
    assert latest["mAP50_95"] == 0.2


def test_merge_epoch_metrics_merges_val_into_existing_train_epoch():
    history, latest = merge_epoch_metrics(
        [{"epoch": 10, "cls_loss": 5.0, "box_loss": 4.0}],
        {"epoch": 10, "mAP50": 0.5, "mAP50_95": 0.25},
    )
    assert history[0]["mAP50"] == 0.5
    assert latest["mAP50"] == 0.5
    assert latest["cls_loss"] == 5.0
