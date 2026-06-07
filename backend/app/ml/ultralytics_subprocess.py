"""Run Ultralytics training in ULTRALYTICS_PYTHON subprocess."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.ml.runtime_env import (
    ULTRALYTICS_PYTHON,
    build_ultralytics_pythonpath,
    build_ultralytics_subprocess_env,
)

logger = logging.getLogger(__name__)

_TRAIN_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "ultralytics_train.py"


def _parse_ultralytics_epoch_line(line: str) -> Optional[Dict[str, Any]]:
    # Examples: "      1/100      2.1G ..."
    m = re.search(r"^\s*(\d+)/(\d+)\s", line)
    if not m:
        return None
    return {
        "epoch": int(m.group(1)),
        "total_epochs": int(m.group(2)),
    }


def _get_metrics_history(task_meta: Dict[str, Any]) -> list:
    hist = task_meta.get("metrics_history")
    return list(hist) if isinstance(hist, list) else []


def run_ultralytics_training_subprocess(
    *,
    model_class: str,
    model_path: str,
    train_args: Dict[str, Any],
    task_runner,
    task_id: int,
    total_epochs: int,
    device: str = "0",
) -> None:
    """
    Execute model.train() in the ultralytics venv and stream stdout for progress updates.

    task_runner: YOLOTrainingTask instance (db, task, request).
    """
    if not Path(ULTRALYTICS_PYTHON).exists():
        raise FileNotFoundError(f"ULTRALYTICS_PYTHON not found: {ULTRALYTICS_PYTHON}")
    if not _TRAIN_SCRIPT.exists():
        raise FileNotFoundError(f"Training script not found: {_TRAIN_SCRIPT}")

    from sqlalchemy.orm.attributes import flag_modified

    serializable_args = {k: v for k, v in train_args.items() if k != "model"}
    for key, val in list(serializable_args.items()):
        if isinstance(val, Path):
            serializable_args[key] = str(val)

    with tempfile.TemporaryDirectory(prefix="ultra_train_") as tmp:
        cfg_path = Path(tmp) / "train_config.json"
        cfg_path.write_text(
            json.dumps(
                {
                    "model_class": model_class,
                    "model_path": model_path,
                    "train_args": serializable_args,
                }
            ),
            encoding="utf-8",
        )
        cmd = [
            ULTRALYTICS_PYTHON,
            str(_TRAIN_SCRIPT),
            "--config",
            str(cfg_path),
        ]
        env = build_ultralytics_subprocess_env(device=device)
        env["PYTHONUNBUFFERED"] = "1"
        # Parent of the `app` package for ultralytics_train imports.
        app_root = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = build_ultralytics_pythonpath(app_root)

        logger.info("Starting Ultralytics subprocess: %s", " ".join(cmd))
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            cwd=str(Path(__file__).resolve().parents[2]),
        )

        db = task_runner.db
        task = task_runner.task
        assert db is not None and task is not None

        from app.ml.ultralytics_train_metrics import parse_lai_metrics_line
        from app.tasks.yolo_metrics import (
            merge_epoch_metrics,
            parse_ultralytics_device_line,
            parse_ultralytics_train_line,
            parse_ultralytics_val_line,
            pick_latest_display_metrics,
        )

        current_epoch = 0
        output_log: List[str] = []

        for line in process.stdout or []:
            output_log.append(line)
            if len(output_log) > 80:
                output_log.pop(0)
            line = line.rstrip()
            logger.info("Ultralytics[%s]: %s", task_id, line)

            db.refresh(task)
            task_meta = task.task_metadata or {}
            if task_meta.get("stop_requested_at"):
                process.terminate()
                task.status = "stopped"
                task.completed_at = datetime.utcnow()
                task.task_metadata = {**task_meta, "stage": "stopped"}
                db.commit()
                break
            if task_meta.get("pause_requested_at"):
                process.terminate()
                task.status = "paused"
                task.task_metadata = {
                    **task_meta,
                    "stage": "paused",
                    "pause_requested_at": None,
                }
                db.commit()
                break

            device_label = parse_ultralytics_device_line(line)
            if device_label:
                task_meta = {**task_meta, "device_used": device_label}

            lai_parsed = parse_lai_metrics_line(line)
            if lai_parsed:
                epoch = lai_parsed.get("epoch")
                if epoch is not None:
                    current_epoch = min(int(epoch), total_epochs)
                history, latest = merge_epoch_metrics(
                    _get_metrics_history(task_meta), lai_parsed
                )
                task_meta = {
                    **task_meta,
                    "metrics_history": history,
                    "latest_metrics": latest,
                    "current_epoch": current_epoch,
                    "total_epochs": total_epochs,
                    "stage": "training",
                }
                progress = 40 + int((current_epoch / max(total_epochs, 1)) * 45)
                task.progress = min(progress, 85)
                task.task_metadata = task_meta
                flag_modified(task, "task_metadata")
                db.commit()
                continue

            train_parsed = parse_ultralytics_train_line(line)
            if train_parsed:
                current_epoch = min(int(train_parsed["epoch"]), total_epochs)
                history, latest = merge_epoch_metrics(
                    _get_metrics_history(task_meta), train_parsed
                )
                task_meta = {
                    **task_meta,
                    "metrics_history": history,
                    "latest_metrics": latest,
                }

            val_parsed = parse_ultralytics_val_line(line, current_epoch)
            if val_parsed:
                history, latest = merge_epoch_metrics(
                    _get_metrics_history(task_meta), val_parsed
                )
                task_meta = {
                    **task_meta,
                    "metrics_history": history,
                    "latest_metrics": latest,
                }

            parsed = _parse_ultralytics_epoch_line(line)
            if parsed:
                current_epoch = min(int(parsed["epoch"]), total_epochs)
                progress = 40 + int((current_epoch / max(total_epochs, 1)) * 45)
                task.progress = min(progress, 85)
                task_meta = {
                    **task_meta,
                    "stage": "training",
                    "current_epoch": current_epoch,
                    "total_epochs": total_epochs,
                }
                if task_meta.get("metrics_history"):
                    task_meta["latest_metrics"] = pick_latest_display_metrics(
                        task_meta["metrics_history"]
                    )
                task.task_metadata = task_meta
                flag_modified(task, "task_metadata")
                db.commit()
                continue

            if train_parsed or val_parsed or device_label:
                task.task_metadata = task_meta
                flag_modified(task, "task_metadata")
                db.commit()

        return_code = process.wait()
        if return_code != 0:
            error_tail = "\n".join(output_log[-30:]).strip()
            detail = f"\n{error_tail}" if error_tail else ""
            raise RuntimeError(
                f"Ultralytics training subprocess failed (exit {return_code}){detail}"
            )
