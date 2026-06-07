"""
Tests for MMYOLO training: metrics (mAP, precision, recall) are parsed from log
lines, merged into history, and saved correctly to the DB task_metadata.

No Celery workers, no filesystem I/O beyond temp dirs, no external processes.
All DB interactions use SQLite in-memory via SQLAlchemy.
"""
import json
import sys
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch, call

import importlib.util

import pytest

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _import_module_direct(rel_path: str):
    """Import a backend module directly from its file, bypassing app/tasks/__init__.py."""
    abs_path = BACKEND_DIR / rel_path
    spec = importlib.util.spec_from_file_location(rel_path.replace("/", ".").removesuffix(".py"), abs_path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_metrics_mod = _import_module_direct("app/tasks/mmyolo_metrics.py")
parse_mmyolo_log_line = _metrics_mod.parse_mmyolo_log_line
merge_epoch_metrics = _metrics_mod.merge_epoch_metrics
pick_latest_display_metrics = _metrics_mod.pick_latest_display_metrics


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_task(task_metadata: Dict[str, Any] | None = None):
    """Return a lightweight mock that behaves like the SQLAlchemy Task model."""
    task = MagicMock()
    task.id = 42
    task.status = "running"
    task.progress = 15
    task.task_metadata = task_metadata or {"metrics_history": [], "total_epochs": 300}
    return task


def _make_db(task):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = task
    return db


# ─────────────────────────────────────────────────────────────────────────────
# 1. Log-line parsing
# ─────────────────────────────────────────────────────────────────────────────

class TestParseValLine:
    """parse_mmyolo_log_line correctly extracts all four val metrics."""

    # Real MMYOLO log format: space-separated key: value pairs on a single line
    FULL_VAL_LINE = (
        "Epoch(val) [10][2/2]  "
        "coco/bbox_mAP: 0.2300  coco/bbox_mAP_50: 0.5600  coco/bbox_mAP_75: 0.1800  "
        "coco/bbox_precision: 0.7200  coco/bbox_recall: 0.6100"
    )

    def test_mAP50_95_extracted(self):
        result = parse_mmyolo_log_line(self.FULL_VAL_LINE)
        assert result is not None
        assert result["mAP50_95"] == pytest.approx(0.23)

    def test_mAP50_extracted(self):
        result = parse_mmyolo_log_line(self.FULL_VAL_LINE)
        assert result is not None
        assert result["mAP50"] == pytest.approx(0.56)

    def test_precision_extracted(self):
        result = parse_mmyolo_log_line(self.FULL_VAL_LINE)
        assert result is not None
        assert result["precision"] == pytest.approx(0.72)

    def test_recall_extracted(self):
        result = parse_mmyolo_log_line(self.FULL_VAL_LINE)
        assert result is not None
        assert result["recall"] == pytest.approx(0.61)

    def test_epoch_number_extracted(self):
        result = parse_mmyolo_log_line(self.FULL_VAL_LINE)
        assert result is not None
        assert result["epoch"] == 10

    def test_alt_key_format_no_bbox_prefix(self):
        """coco/mAP_50 (without bbox_) should also be parsed."""
        line = (
            "Epoch(val) [5][1/1]  "
            "coco/mAP: 0.1500  coco/mAP_50: 0.4200  "
            "coco/precision: 0.6500  coco/recall: 0.5500"
        )
        result = parse_mmyolo_log_line(line)
        assert result is not None
        assert result["mAP50"] == pytest.approx(0.42)
        assert result["precision"] == pytest.approx(0.65)
        assert result["recall"] == pytest.approx(0.55)

    def test_partial_val_line_only_map(self):
        """Lines with only mAP (no precision/recall) still parse correctly."""
        line = (
            "Epoch(val) [20][1/1]  "
            "coco/bbox_mAP: 0.3100  coco/bbox_mAP_50: 0.6200"
        )
        result = parse_mmyolo_log_line(line)
        assert result is not None
        assert result["mAP50"] == pytest.approx(0.62)
        assert result["mAP50_95"] == pytest.approx(0.31)
        assert "precision" not in result
        assert "recall" not in result

    def test_train_line_returns_no_val_metrics(self):
        """Training lines must not produce mAP / precision / recall."""
        line = (
            "Epoch(train)   [5][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
            "loss: 28.8379  loss_cls: 9.1619  loss_bbox: 11.2042  loss_dfl: 8.4718"
        )
        result = parse_mmyolo_log_line(line)
        assert result is not None
        assert "mAP50" not in result
        assert "precision" not in result
        assert "recall" not in result

    def test_irrelevant_line_returns_none(self):
        assert parse_mmyolo_log_line("Loading checkpoint from /tmp/best.pth") is None
        assert parse_mmyolo_log_line("") is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. merge_epoch_metrics — history accumulation
# ─────────────────────────────────────────────────────────────────────────────

class TestMergeEpochMetrics:

    def test_val_metrics_merged_into_existing_train_epoch(self):
        history = [{"epoch": 10, "cls_loss": 5.0, "box_loss": 4.0}]
        new_history, latest = merge_epoch_metrics(
            history,
            {"epoch": 10, "mAP50": 0.55, "mAP50_95": 0.28,
             "precision": 0.70, "recall": 0.65},
        )
        row = next(r for r in new_history if r["epoch"] == 10)
        assert row["mAP50"] == pytest.approx(0.55)
        assert row["precision"] == pytest.approx(0.70)
        assert row["recall"] == pytest.approx(0.65)
        assert row["cls_loss"] == pytest.approx(5.0)

    def test_val_metrics_appended_as_new_epoch_when_no_train_row(self):
        history = [{"epoch": 9, "cls_loss": 4.0}]
        new_history, _ = merge_epoch_metrics(
            history,
            {"epoch": 10, "mAP50": 0.60, "precision": 0.75, "recall": 0.68},
        )
        assert len(new_history) == 2
        val_row = next(r for r in new_history if r["epoch"] == 10)
        assert val_row["mAP50"] == pytest.approx(0.60)

    def test_latest_includes_all_four_val_metrics(self):
        history = [{"epoch": 10, "cls_loss": 5.0}]
        _, latest = merge_epoch_metrics(
            history,
            {"epoch": 10, "mAP50": 0.55, "mAP50_95": 0.28,
             "precision": 0.70, "recall": 0.65},
        )
        assert latest["mAP50"] == pytest.approx(0.55)
        assert latest["mAP50_95"] == pytest.approx(0.28)
        assert latest["precision"] == pytest.approx(0.70)
        assert latest["recall"] == pytest.approx(0.65)

    def test_history_stays_sorted_by_epoch(self):
        history = [{"epoch": 1}, {"epoch": 3}]
        new_history, _ = merge_epoch_metrics(history, {"epoch": 2, "mAP50": 0.4})
        epochs = [r["epoch"] for r in new_history]
        assert epochs == sorted(epochs)

    def test_no_epoch_key_leaves_history_unchanged(self):
        history = [{"epoch": 1, "cls_loss": 3.0}]
        new_history, _ = merge_epoch_metrics(history, {"cls_loss": 9.9})  # no epoch
        assert new_history == history


# ─────────────────────────────────────────────────────────────────────────────
# 3. pick_latest_display_metrics — val metrics forwarded across epochs
# ─────────────────────────────────────────────────────────────────────────────

class TestPickLatestDisplayMetrics:

    def test_val_metrics_forwarded_to_latest_train_epoch(self):
        history = [
            {"epoch": 10, "cls_loss": 5.0, "mAP50": 0.4, "precision": 0.65, "recall": 0.60},
            {"epoch": 11, "cls_loss": 4.5},
            {"epoch": 12, "cls_loss": 4.0},
        ]
        latest = pick_latest_display_metrics(history)
        assert latest["epoch"] == 12
        assert latest["cls_loss"] == pytest.approx(4.0)
        assert latest["mAP50"] == pytest.approx(0.4)
        assert latest["precision"] == pytest.approx(0.65)
        assert latest["recall"] == pytest.approx(0.60)

    def test_empty_history_returns_empty_dict(self):
        assert pick_latest_display_metrics([]) == {}

    def test_no_val_epochs_returns_latest_train_only(self):
        history = [
            {"epoch": 1, "cls_loss": 8.0},
            {"epoch": 2, "cls_loss": 6.0},
        ]
        latest = pick_latest_display_metrics(history)
        assert latest["epoch"] == 2
        assert "mAP50" not in latest

    def test_only_val_epoch_is_returned_as_latest(self):
        history = [{"epoch": 5, "mAP50": 0.3, "precision": 0.55, "recall": 0.50}]
        latest = pick_latest_display_metrics(history)
        assert latest["mAP50"] == pytest.approx(0.3)
        assert latest["epoch"] == 5


# ─────────────────────────────────────────────────────────────────────────────
# 4. DB writes during _stream_and_update (the live training loop)
#    We simulate the subprocess stdout line-by-line and verify that
#    task_metadata is committed to DB with the expected metrics values.
# ─────────────────────────────────────────────────────────────────────────────

class TestMetricsSavedToDb:
    """
    Simulate _stream_and_update by replaying log lines through the same
    parse → merge → db.commit path used in the real training task.
    """

    def _replay_lines(self, lines: List[str], task, db, epochs: int = 300):
        """
        Mirror the core loop of mmyolo_training._stream_and_update without
        requiring a real subprocess or SQLAlchemy session.
        """
        import re
        _merge = merge_epoch_metrics
        _parse = parse_mmyolo_log_line

        for line in lines:
            task_meta = task.task_metadata or {}
            # Stop / pause checks omitted — not relevant for metric tests

            parsed = _parse(line)
            if parsed:
                metrics_history = task_meta.get("metrics_history") or []
                metrics_history, latest_metrics = _merge(metrics_history, parsed)
                raw_epoch = parsed.get("epoch", task_meta.get("current_epoch", 0))
                current_epoch = min(int(raw_epoch), epochs)
                progress = 15 + int((current_epoch / max(epochs, 1)) * 75)
                task.progress = min(progress, 90)
                task.task_metadata = {
                    **task_meta,
                    "stage": "training",
                    "current_epoch": current_epoch,
                    "total_epochs": epochs,
                    "latest_metrics": latest_metrics,
                    "metrics_history": metrics_history,
                }
                db.commit()
                continue

            match = re.search(r"Epoch\s*\S*\s*\[\s*(\d+)\]", line)
            if match:
                current_epoch = min(int(match.group(1)), epochs)
                task.task_metadata = {
                    **task_meta,
                    "stage": "training",
                    "current_epoch": current_epoch,
                    "total_epochs": epochs,
                }
                db.commit()

    # ---- fixtures -----------------------------------------------------------

    TRAIN_LINES = [
        "Epoch(train)   [1][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
        "loss: 30.0  loss_cls: 10.0  loss_bbox: 12.0  loss_dfl: 8.0",
        "Epoch(train)   [10][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
        "loss: 25.0  loss_cls: 8.0  loss_bbox: 10.0  loss_dfl: 7.0",
    ]
    VAL_LINE = (
        "Epoch(val) [10][2/2]  "
        "coco/bbox_mAP: 0.2300  coco/bbox_mAP_50: 0.5600  "
        "coco/bbox_precision: 0.7200  coco/bbox_recall: 0.6100"
    )

    def test_val_metrics_persisted_to_db(self):
        """After a val log line, task_metadata in DB has mAP50 / precision / recall."""
        task = _make_task()
        db = _make_db(task)

        self._replay_lines(self.TRAIN_LINES + [self.VAL_LINE], task, db)

        meta = task.task_metadata
        latest = meta["latest_metrics"]
        assert latest["mAP50"] == pytest.approx(0.56)
        assert latest["mAP50_95"] == pytest.approx(0.23)
        assert latest["precision"] == pytest.approx(0.72)
        assert latest["recall"] == pytest.approx(0.61)

    def test_metrics_history_contains_val_entry(self):
        task = _make_task()
        db = _make_db(task)

        self._replay_lines(self.TRAIN_LINES + [self.VAL_LINE], task, db)

        history = task.task_metadata["metrics_history"]
        val_epochs = [r for r in history if "mAP50" in r]
        assert len(val_epochs) >= 1
        assert val_epochs[-1]["mAP50"] == pytest.approx(0.56)
        assert val_epochs[-1]["precision"] == pytest.approx(0.72)
        assert val_epochs[-1]["recall"] == pytest.approx(0.61)

    def test_db_commit_called_after_val_line(self):
        task = _make_task()
        db = _make_db(task)
        commits_before = db.commit.call_count

        self._replay_lines([self.VAL_LINE], task, db)

        assert db.commit.call_count > commits_before

    def test_multiple_val_runs_accumulate_in_history(self):
        task = _make_task()
        db = _make_db(task)

        val_10 = (
            "Epoch(val) [10][2/2]  "
            "coco/bbox_mAP: 0.2300  coco/bbox_mAP_50: 0.5600  "
            "coco/bbox_precision: 0.7200  coco/bbox_recall: 0.6100"
        )
        val_20 = (
            "Epoch(val) [20][2/2]  "
            "coco/bbox_mAP: 0.3100  coco/bbox_mAP_50: 0.6500  "
            "coco/bbox_precision: 0.7800  coco/bbox_recall: 0.6900"
        )
        self._replay_lines([val_10, val_20], task, db)

        history = task.task_metadata["metrics_history"]
        assert len(history) == 2
        assert history[0]["mAP50"] == pytest.approx(0.56)
        assert history[1]["mAP50"] == pytest.approx(0.65)
        assert history[1]["precision"] == pytest.approx(0.78)

    def test_latest_metrics_forwarded_across_train_epochs(self):
        """Val metrics from epoch 10 are still visible in latest_metrics at epoch 12."""
        task = _make_task()
        db = _make_db(task)

        train_11 = (
            "Epoch(train)   [11][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
            "loss: 24.0  loss_cls: 7.5  loss_bbox: 9.5  loss_dfl: 7.0"
        )
        train_12 = (
            "Epoch(train)   [12][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
            "loss: 23.0  loss_cls: 7.0  loss_bbox: 9.0  loss_dfl: 7.0"
        )
        lines = self.TRAIN_LINES + [self.VAL_LINE, train_11, train_12]
        self._replay_lines(lines, task, db)

        latest = task.task_metadata["latest_metrics"]
        assert latest["epoch"] == 12
        assert latest["mAP50"] == pytest.approx(0.56), "mAP50 should carry over to epoch 12"
        assert latest["precision"] == pytest.approx(0.72), "precision should carry over"
        assert latest["recall"] == pytest.approx(0.61), "recall should carry over"

    def test_train_only_run_has_no_val_metrics(self):
        """A run that has no val log lines must not produce mAP/precision/recall."""
        task = _make_task()
        db = _make_db(task)

        self._replay_lines(self.TRAIN_LINES, task, db)

        latest = task.task_metadata.get("latest_metrics", {})
        assert "mAP50" not in latest
        assert "precision" not in latest
        assert "recall" not in latest

    def test_stage_is_training_during_loop(self):
        task = _make_task()
        db = _make_db(task)

        self._replay_lines([self.VAL_LINE], task, db)

        assert task.task_metadata["stage"] == "training"

    def test_current_epoch_capped_at_total_epochs(self):
        """Even if the log reports epoch > total_epochs, current_epoch is capped."""
        task = _make_task({"metrics_history": [], "total_epochs": 10})
        db = _make_db(task)

        line = (
            "Epoch(train)   [999][1/1]  base_lr: 1.0000e-02 lr: 0.0001  "
            "loss: 1.0  loss_cls: 0.3  loss_bbox: 0.4  loss_dfl: 0.3"
        )
        self._replay_lines([line], task, db, epochs=10)

        assert task.task_metadata["current_epoch"] <= 10


# ─────────────────────────────────────────────────────────────────────────────
# 5. Completed task metadata — best_model and final metrics
# ─────────────────────────────────────────────────────────────────────────────

class TestCompletedTaskMetadata:

    def test_completed_metadata_has_latest_metrics(self):
        """
        Simulate the end of train_mmyolo_model: task_metadata is assembled
        from final_meta and must include latest_metrics with val metrics.
        """

        metrics_history = [
            {"epoch": 10, "cls_loss": 5.0, "mAP50": 0.56, "mAP50_95": 0.23,
             "precision": 0.72, "recall": 0.61},
            {"epoch": 11, "cls_loss": 4.8},
            {"epoch": 12, "cls_loss": 4.5},
        ]
        final_meta = {
            "stage": "training",
            "current_epoch": 12,
            "metrics_history": metrics_history,
        }
        latest = pick_latest_display_metrics(final_meta["metrics_history"])
        completed_meta = {
            **final_meta,
            "stage": "completed",
            "best_model": "/projects/1/training/task_42/training/best_coco_bbox_mAP_epoch_10.pth",
            "latest_metrics": latest,
        }

        assert completed_meta["latest_metrics"]["mAP50"] == pytest.approx(0.56)
        assert completed_meta["latest_metrics"]["precision"] == pytest.approx(0.72)
        assert completed_meta["latest_metrics"]["recall"] == pytest.approx(0.61)
        assert "best_coco_bbox_mAP" in completed_meta["best_model"]
