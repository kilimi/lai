"""MMYOLO Celery training task."""
import logging
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.celery.gpu_app import celery_app
from app.database import SessionLocal
from app.models import Task as TaskModel
from app.tasks.mmyolo_config import (
    MMYOLOConfigParams,
    build_mmyolo_config_content,
    mmyolo_cfg_options_list,
    resolve_mmyolo_base_config,
    resolve_mmyolo_split_paths,
)
from app.tasks.mmyolo_dji import prepare_dji_mmyolo_repo
from app.tasks.mmyolo_metrics import merge_epoch_metrics, parse_mmyolo_log_line, pick_latest_display_metrics
from app.tasks.training_common import MMYOLO_PYTHON, TrainingTask
from app.tasks.training_visualization import (
    create_coco_training_examples,
    create_mmyolo_prediction_preview,
)

logger = logging.getLogger(__name__)


def _task_output_base(project_id: int, task_id: int) -> Path:
    output_base = Path("projects") / str(project_id) / "training" / f"task_{task_id}"
    output_base.mkdir(parents=True, exist_ok=True)
    return output_base


def _validate_dji_mode(num_classes: int) -> str:
    if num_classes > 10:
        raise ValueError(
            f"DJI drone models require num_classes <= 10, but dataset has {num_classes} classes. "
            "Please reduce the number of classes or disable DJI mode."
        )
    config_id = "yolov8_s_syncbn_fast_8xb16-500e_coco"
    logger.info(f"DJI mode enabled: forcing config to {config_id}, num_classes={num_classes}")
    return config_id


def _build_training_command(
    *,
    task_id: int,
    cfg_path: Path,
    batch_size: int,
    epochs: int,
    is_dji_mode: bool,
    dji_repo: Optional[str],
) -> List[str]:
    cfg_options = mmyolo_cfg_options_list(batch_size=batch_size, epochs=epochs)
    if is_dji_mode:
        if not dji_repo or not Path(dji_repo).exists():
            raise RuntimeError(
                f"DJI mode enabled but repo not found at {dji_repo}. "
                "DJI patch preparation may have failed."
            )
        train_script = Path(dji_repo) / "tools" / "train.py"
        if not train_script.exists():
            raise RuntimeError(f"DJI training script not found: {train_script}")

        version_check = subprocess.run(
            ["git", "-C", dji_repo, "describe", "--tags"],
            capture_output=True,
            text=True,
        )
        logger.info(f"DJI MMYOLO repo version: {version_check.stdout.strip()}")
        logger.info(f"MMYOLO DJI task {task_id}: using DJI repo at {dji_repo}")
        return [
            MMYOLO_PYTHON,
            str(train_script),
            str(cfg_path.resolve()),
            "--cfg-options",
            *cfg_options,
        ]

    return [
        MMYOLO_PYTHON,
        "-m",
        "mim",
        "run",
        "mmyolo",
        "train",
        str(cfg_path.resolve()),
        "--cfg-options",
        *cfg_options,
    ]


def _build_training_env(*, device: str, is_dji_mode: bool, dji_repo: Optional[str]) -> dict:
    from app.ml.runtime_env import build_mmyolo_subprocess_env

    dji_dir = dji_repo if is_dji_mode and dji_repo else None
    if dji_dir:
        logger.info(f"DJI mode: PYTHONPATH={dji_dir}")
    return build_mmyolo_subprocess_env(device=device, dji_repo_dir=dji_dir)


def _create_mmyolo_training_examples(
    db,
    task: TaskModel,
    task_id: int,
    output_base: Path,
    dataset_dir: Path,
    class_names: list,
) -> None:
    """Create annotated dataset previews for MMYOLO tasks (best-effort)."""
    try:
        examples_dir = output_base / "examples"
        create_coco_training_examples(
            dataset_dir=dataset_dir,
            output_dir=examples_dir,
            class_names=class_names,
            num_examples=16,
            grid_size=(4, 4),
        )

        example_images = {}
        for split in ["train", "val", "test"]:
            if (examples_dir / f"{split}_batch.jpg").exists():
                example_images[split] = f"/tasks/{task_id}/examples/{split}"

        task.task_metadata = {
            **(task.task_metadata or {}),
            "examples_path": str(examples_dir),
            "example_images": example_images,
        }
        db.commit()
        logger.info(f"MMYOLO task {task_id}: created training examples in {examples_dir}")
    except Exception as viz_err:
        logger.warning(
            f"MMYOLO task {task_id}: failed to create training examples: {viz_err}",
            exc_info=True,
        )


def _stream_training_output(
    process: subprocess.Popen,
    db,
    task: TaskModel,
    task_id: int,
    epochs: int,
) -> List[str]:
    from sqlalchemy.orm.attributes import flag_modified

    epoch_log: List[str] = []
    for line in process.stdout:  # type: ignore[union-attr]
        line = line.rstrip()
        logger.debug(f"MMYOLO[{task_id}]: {line}")
        epoch_log.append(line)

        db.refresh(task)
        task_meta = task.task_metadata or {}
        if task_meta.get("stop_requested_at"):
            process.terminate()
            task.status = "stopped"
            task.completed_at = datetime.utcnow()
            task.task_metadata = {**task_meta, "stage": "stopped"}
            db.commit()
            return epoch_log
        if task_meta.get("pause_requested_at"):
            process.terminate()
            task.status = "paused"
            task.task_metadata = {**task_meta, "stage": "paused", "pause_requested_at": None}
            db.commit()
            return epoch_log

        parsed = parse_mmyolo_log_line(line)
        if parsed:
            metrics_history = task_meta.get("metrics_history") or []
            metrics_history, latest_metrics = merge_epoch_metrics(metrics_history, parsed)
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
            flag_modified(task, "task_metadata")
            db.commit()
            continue

        match = re.search(r"Epoch\s*\S*\s*\[\s*(\d+)\]", line)
        if match:
            current_epoch = min(int(match.group(1)), epochs)
            progress = 15 + int((current_epoch / max(epochs, 1)) * 75)
            task.progress = min(progress, 90)
            task.task_metadata = {
                **task_meta,
                "stage": "training",
                "current_epoch": current_epoch,
                "total_epochs": epochs,
            }
            db.commit()

    return epoch_log


def _find_best_model(weights_dir: Path) -> Optional[str]:
    # Explicit well-known name
    if (weights_dir / "best.pth").exists():
        return str(weights_dir / "best.pth")

    # MMYOLO saves best checkpoint as best_coco_bbox_mAP_epoch_N.pth (or similar best_*.pth)
    best_candidates = sorted(
        weights_dir.glob("best_*.pth"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if best_candidates:
        return str(best_candidates[0])

    # Fallback: use last_checkpoint pointer file (MMEngine standard)
    last_cp_file = weights_dir / "last_checkpoint"
    if last_cp_file.exists():
        try:
            name = last_cp_file.read_text(encoding="utf-8").strip()
            candidate = Path(name) if Path(name).is_absolute() else weights_dir / name
            if candidate.exists():
                return str(candidate)
        except Exception:
            pass

    # Final fallback: epoch_last.pth or most recent epoch_*.pth
    if (weights_dir / "epoch_last.pth").exists():
        return str(weights_dir / "epoch_last.pth")

    epoch_candidates = sorted(
        weights_dir.glob("epoch_*.pth"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return str(epoch_candidates[0]) if epoch_candidates else None


def _mark_task_failed(db, task_id: int, exc: Exception) -> None:
    task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
    if not task:
        return
    task_meta = task.task_metadata or {}
    if task.status in ("paused", "stopped"):
        return
    task.status = "failed"
    task.completed_at = datetime.utcnow()
    task.error_message = str(exc)
    task.task_metadata = {**task_meta, "stage": "failed", "error": str(exc)}
    db.commit()


@celery_app.task(
    base=TrainingTask,
    bind=True,
    name="app.tasks.training_tasks.train_mmyolo_model",
)
def train_mmyolo_model(self, task_id: int, training_config: Dict[str, Any]):
    """Train an MMYOLO model via OpenMMLab (mim or DJI-patched repo)."""
    db = SessionLocal()
    try:
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            logger.error(f"MMYOLO task {task_id} not found in DB")
            return

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.task_metadata = {**(task.task_metadata or {}), "stage": "preparing_dataset"}
        db.commit()

        project_id = training_config["project_id"]
        output_base = _task_output_base(project_id, task_id)
        dataset_dir = output_base / "dataset"

        arch = training_config.get("arch", "rtmdet")
        dji_patch_path = training_config.get("dji_patch_path")
        epochs = training_config.get("epochs", 300)
        batch_size = training_config.get("batch_size", 16)
        image_size = training_config.get("image_size", 640)
        device = training_config.get("device", "0")
        is_dji_mode = bool(dji_patch_path)
        dji_use_widen_factor_025 = training_config.get("dji_use_widen_factor_025", True)

        if dji_patch_path:
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "preparing_dji_patch",
                "dji_patch_path": dji_patch_path,
            }
            db.commit()
            repo_dir = prepare_dji_mmyolo_repo(dji_patch_path)
            task.task_metadata = {
                **(task.task_metadata or {}),
                "stage": "dji_patch_ready",
                "dji_repo_dir": str(repo_dir),
            }
            db.commit()

        from app.ml.dataset import prepare_mmyolo_dataset

        dataset_info = prepare_mmyolo_dataset(
            db,
            training_config["dataset_configs"],
            dataset_dir,
            task=training_config.get("task", "detect"),
            remove_images_without_annotations=training_config.get(
                "remove_images_without_annotations", True
            ),
        )

        task.task_metadata = {
            **(task.task_metadata or {}),
            "stage": "dataset_prepared",
            "class_names": dataset_info["class_names"],
            "num_classes": dataset_info["class_count"],
            "image_counts": dataset_info["image_counts"],
            "total_epochs": epochs,
            "metrics_history": [],
        }
        task.progress = 10
        db.commit()

        _create_mmyolo_training_examples(
            db,
            task,
            task_id,
            output_base,
            dataset_dir,
            dataset_info["class_names"],
        )

        config_id = training_config.get("config_id", f"{arch}_{training_config.get('size', 's')}")
        num_classes = dataset_info["class_count"]
        dji_repo = task.task_metadata.get("dji_repo_dir") if is_dji_mode else None
        if is_dji_mode:
            config_id = _validate_dji_mode(num_classes)

        train_json = dataset_info["train_json"]
        train_json_abs, train_images_abs, val_json_abs, val_images_abs = resolve_mmyolo_split_paths(
            dataset_info, dataset_dir
        )
        if val_json_abs == train_json_abs:
            logger.info(
                "MMYOLO task %s: no val split (%s val images) — using train set for validation",
                task_id,
                dataset_info.get("image_counts", {}).get("val", 0),
            )

        train_image_count = int(dataset_info.get("image_counts", {}).get("train", 0) or 0)
        if train_image_count > 0:
            batch_size = max(1, min(int(batch_size), train_image_count))

        base_cfg = resolve_mmyolo_base_config(config_id, dji_repo_dir=dji_repo)
        from app.ml.mmyolo_catalog import (
            MMYOLO_PRETRAINED_DOWNLOAD_NOTICE,
            mmyolo_pretrained_checkpoint,
            mmyolo_pretrained_requires_download,
            mmyolo_ui_alias_for_config,
            resolve_mmyolo_pretrained_local_path,
        )

        skip_pretrained = is_dji_mode and dji_use_widen_factor_025
        needs_local_pretrained = not skip_pretrained and mmyolo_pretrained_checkpoint(
            config_id
        ) is not None
        if is_dji_mode and not skip_pretrained:
            # DJI edge-drone training always uses yolov8_s — require offline cache.
            needs_local_pretrained = True
        if needs_local_pretrained and mmyolo_pretrained_requires_download(base_cfg):
            alias = mmyolo_ui_alias_for_config(config_id) or ("yolov8_s" if is_dji_mode else config_id)
            raise RuntimeError(
                f"{MMYOLO_PRETRAINED_DOWNLOAD_NOTICE} Missing alias: {alias!r}."
            )

        pretrained = None if skip_pretrained else resolve_mmyolo_pretrained_local_path(base_cfg)
        if pretrained:
            logger.info(
                "MMYOLO task %s: fine-tuning from cached pretrained weights %s",
                task_id,
                pretrained,
            )
        elif skip_pretrained:
            logger.info(
                "MMYOLO task %s: DJI widen_factor=0.25 — training without COCO load_from "
                "(YOLOv8-S checkpoint is incompatible)",
                task_id,
            )
        else:
            logger.warning(
                "MMYOLO task %s: no cached COCO pretrained checkpoint for config %s — training from scratch",
                task_id,
                base_cfg,
            )

        cfg_content = build_mmyolo_config_content(
            MMYOLOConfigParams(
                base_cfg=base_cfg,
                num_classes=num_classes,
                class_names_py=repr(tuple(dataset_info["class_names"])),
                epochs=epochs,
                batch_size=batch_size,
                image_size=image_size,
                work_dir=str(output_base / "training"),
                train_json_abs=train_json_abs,
                val_json_abs=val_json_abs,
                train_images_abs=train_images_abs,
                val_images_abs=val_images_abs,
                is_dji_mode=is_dji_mode,
                dji_use_widen_factor_025=dji_use_widen_factor_025,
            )
        )

        cfg_path = output_base / "mmyolo_config.py"
        cfg_path.write_text(cfg_content)

        task.task_metadata = {**(task.task_metadata or {}), "stage": "training", "config_path": str(cfg_path)}
        task.progress = 15
        db.commit()

        if is_dji_mode:
            logger.info(
                "DJI config: base=%s, widen_factor=%s, num_classes=%s, image_size=%s",
                base_cfg,
                "0.25" if dji_use_widen_factor_025 else "0.5 (default)",
                num_classes,
                image_size,
            )

        cmd = _build_training_command(
            task_id=task_id,
            cfg_path=cfg_path,
            batch_size=batch_size,
            epochs=epochs,
            is_dji_mode=is_dji_mode,
            dji_repo=dji_repo,
        )
        logger.info(f"MMYOLO task {task_id}: running command: {' '.join(cmd)}")

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=_build_training_env(device=device, is_dji_mode=is_dji_mode, dji_repo=dji_repo),
        )

        epoch_log = _stream_training_output(process, db, task, task_id, epochs)
        process.wait()

        if process.returncode != 0:
            error_tail = "\n".join(epoch_log[-30:])
            raise RuntimeError(
                f"mim run mmyolo train exited with code {process.returncode}.\n{error_tail}"
            )

        weights_dir = output_base / "training"
        best_model = _find_best_model(weights_dir)
        if is_dji_mode and best_model:
            canonical_best = weights_dir / "best.pth"
            best_path = Path(best_model)
            if best_path.exists() and best_path.resolve() != canonical_best.resolve():
                shutil.copy2(best_path, canonical_best)
                logger.info("DJI mode: copied best checkpoint to %s", canonical_best)
                best_model = str(canonical_best)
            elif canonical_best.exists():
                best_model = str(canonical_best)
        last_model_path = weights_dir / "epoch_last.pth"
        if not last_model_path.exists() and best_model:
            last_model_path = Path(best_model)

        example_images = dict((final_meta := (task.task_metadata or {})).get("example_images") or {})
        examples_dir = output_base / "examples"
        if create_mmyolo_prediction_preview(weights_dir, examples_dir):
            example_images["val_predictions"] = f"/tasks/{task_id}/examples/val_predictions"

        task.status = "completed"
        task.completed_at = datetime.utcnow()
        task.progress = 100
        metrics_history = final_meta.get("metrics_history") or []
        finished_epoch = min(int(final_meta.get("current_epoch") or epochs), epochs)
        task.task_metadata = {
            **final_meta,
            "stage": "completed",
            "best_model": best_model,
            "last_model": str(last_model_path) if last_model_path.exists() else best_model,
            "results_dir": str(weights_dir),
            "mmyolo_vis_dir": str(weights_dir / "vis_data"),
            "class_names": dataset_info["class_names"],
            "class_count": dataset_info["class_count"],
            "image_counts": dataset_info["image_counts"],
            "current_epoch": finished_epoch,
            "total_epochs": epochs,
            "latest_metrics": pick_latest_display_metrics(metrics_history),
            "example_images": example_images,
        }
        db.commit()
        logger.info(f"MMYOLO task {task_id} completed. best_model={best_model}")
        return {"status": "completed", "task_id": task_id, "best_model": best_model}

    except Exception as exc:
        logger.error(f"Error in MMYOLO training task {task_id}: {exc}", exc_info=True)
        _mark_task_failed(db, task_id, exc)
        raise
    finally:
        db.close()
