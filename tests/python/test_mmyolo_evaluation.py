#!/usr/bin/env python3
"""Smoke tests for MMYOLO evaluation helpers."""
from pathlib import Path

import pytest

pytest.importorskip("torch")

from app.tasks.mmyolo_evaluation import (
    extract_predictions_from_result,
    resolve_mmyolo_checkpoint,
    resolve_mmyolo_config_path,
)


class FakeInstances:
    def __init__(self, scores, labels, bboxes):
        import torch

        self.scores = torch.tensor(scores, dtype=torch.float32)
        self.labels = torch.tensor(labels, dtype=torch.int64)
        self.bboxes = torch.tensor(bboxes, dtype=torch.float32)

    def __len__(self):
        return len(self.scores)


class FakeResult:
    def __init__(self, instances):
        self.pred_instances = instances


def test_extract_predictions_filters_by_confidence():
    result = FakeResult(
        FakeInstances(
            scores=[0.9, 0.1],
            labels=[0, 1],
            bboxes=[[10, 10, 50, 50], [60, 60, 90, 90]],
        )
    )
    preds = extract_predictions_from_result(
        result, image_id=42, num_classes=2, conf_threshold=0.5
    )
    assert len(preds) == 1
    assert preds[0]["image_id"] == 42
    assert preds[0]["class_id"] == 0
    assert preds[0]["bbox_xyxy"] == [10.0, 10.0, 50.0, 50.0]


def test_resolve_mmyolo_checkpoint_best(tmp_path):
    ckpt = tmp_path / "epoch_10.pth"
    ckpt.write_bytes(b"x")
    meta = {"results_dir": str(tmp_path)}
    assert resolve_mmyolo_checkpoint(meta, "best") == str(ckpt.resolve())
    assert resolve_mmyolo_checkpoint(meta, "last") == str(ckpt.resolve())


def test_resolve_mmyolo_config_from_metadata(tmp_path, monkeypatch):
    cfg = tmp_path / "mmyolo_config.py"
    cfg.write_text("# test")
    meta = {"config_path": str(cfg)}
    assert resolve_mmyolo_config_path(1, meta, project_id=99) == str(cfg.resolve())


if __name__ == "__main__":
    import tempfile

    test_extract_predictions_filters_by_confidence()
    with tempfile.TemporaryDirectory() as tmp:
        ckpt = Path(tmp) / "epoch_10.pth"
        ckpt.write_bytes(b"x")
        meta = {"results_dir": tmp}
        assert resolve_mmyolo_checkpoint(meta, "best") == str(ckpt.resolve())
    print("OK")
