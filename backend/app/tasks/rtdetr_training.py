"""RT-DETR Celery training task."""
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from app.celery.gpu_app import celery_app
from app.database import SessionLocal
from app.models import Task as TaskModel
from app.tasks.training_common import TrainingTask

logger = logging.getLogger(__name__)


@celery_app.task(base=TrainingTask, bind=True, name="app.tasks.training_tasks.train_rtdetr_model")
def train_rtdetr_model(self, task_id: int, training_config: Dict[str, Any]):
    """Train RT-DETR (Real-Time Detection Transformer) model."""
    from app.ml.ultralytics_subprocess import run_ultralytics_training_subprocess
    from app.tasks.yolo_training_helpers import get_runtime_training_project

    db = SessionLocal()

    def _create_rtdetr_training_examples(task: TaskModel) -> None:
        try:
            from app.tasks.training_visualization import create_training_examples

            output_base = Path(training_config["output_dir"])
            examples_dir = output_base / "examples"
            class_names = []
            task_meta = task.task_metadata or {}

            class_names_from_meta = task_meta.get("class_names")
            if isinstance(class_names_from_meta, list):
                class_names = [str(c) for c in class_names_from_meta]

            classes_from_meta = task_meta.get("classes")
            if not class_names and isinstance(classes_from_meta, list):
                class_names = [str(c) for c in classes_from_meta]

            if not class_names:
                data_yaml = training_config.get("data_yaml")
                if data_yaml and Path(data_yaml).exists():
                    try:
                        import yaml

                        with open(data_yaml, "r") as f:
                            yaml_data = yaml.safe_load(f) or {}
                        names = yaml_data.get("names", [])
                        if isinstance(names, dict):
                            class_names = [str(v) for _, v in sorted(names.items(), key=lambda kv: int(kv[0]))]
                        elif isinstance(names, list):
                            class_names = [str(v) for v in names]
                    except Exception as yaml_err:
                        logger.warning(
                            f"RT-DETR task {task_id}: failed reading class names from data.yaml: {yaml_err}"
                        )

            if not class_names:
                logger.warning(f"RT-DETR task {task_id}: skipping examples because class names are unavailable")
                return

            create_training_examples(
                dataset_dir=output_base,
                output_dir=examples_dir,
                class_names=class_names,
                num_examples=16,
                is_segmentation=False,
                grid_size=(4, 4),
            )

            example_images = {}
            for split in ["train", "val", "test"]:
                example_path = examples_dir / f"{split}_batch.jpg"
                if example_path.exists():
                    example_images[split] = f"/tasks/{task_id}/examples/{split}"

            task.task_metadata = {
                **task_meta,
                "examples_path": str(examples_dir),
                "example_images": example_images,
            }
            db.commit()
            logger.info(f"RT-DETR task {task_id}: created training examples in {examples_dir}")
        except Exception as viz_err:
            logger.warning(
                f"RT-DETR task {task_id}: failed to create training examples: {viz_err}",
                exc_info=True,
            )

    try:
        logger.info(f"Starting RT-DETR training for task {task_id}")

        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            raise ValueError(f"Task {task_id} not found")

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 0
        task.task_metadata = {
            **(task.task_metadata or {}),
            "stage": "initializing",
            "celery_task_id": self.request.id,
            "training_config": training_config,
        }
        db.commit()

        _create_rtdetr_training_examples(task)

        model_type = training_config.get("model_type", "rtdetr-l.pt")
        resume_from = training_config.get("resume_from")
        logger.info(f"RT-DETR model: {model_type}, resume_from={resume_from}")

        if resume_from and Path(resume_from).exists():
            model_path = resume_from
        else:
            model_path = model_type

        runtime_project = get_runtime_training_project(task_id)

        from app.tasks.yolo_training_helpers import build_yolo_training_args

        dataset_info = {"yaml_path": training_config["data_yaml"]}
        train_args = build_yolo_training_args(
            dataset_info,
            training_config,
            runtime_project,
            task_id,
        )
        train_args["cache"] = False
        train_args["workers"] = 8
        if resume_from:
            train_args["resume"] = True

        total_epochs = training_config.get("epochs", 100)
        device = str(training_config.get("device", "0"))

        class _RTDETRTaskRunner:
            pass

        runner = _RTDETRTaskRunner()
        runner.db = db
        runner.task = task
        runner.request = self.request

        logger.info(f"Starting RT-DETR subprocess training with args: {list(train_args.keys())}")
        run_ultralytics_training_subprocess(
            model_class="rtdetr",
            model_path=model_path,
            train_args=train_args,
            task_runner=runner,
            task_id=task_id,
            total_epochs=total_epochs,
            device=device,
        )

        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if not task:
            return {"status": "completed", "task_id": task_id}

        if task.status in ("paused", "stopped"):
            logger.info(f"RT-DETR task {task_id} finished training loop with status='{task.status}'")
            return {"status": task.status, "task_id": task_id}

        logger.info(f"RT-DETR training completed for task {task_id}")

        output_base = Path(training_config["output_dir"])
        persisted_weights_dir = output_base / "training" / "weights"
        persisted_weights_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(persisted_weights_dir, 0o777)
        except OSError:
            pass

        runtime_save_dir = Path(train_args.get("project", "")) / train_args.get("name", "training")
        if not runtime_save_dir.exists():
            runtime_save_dir = None

        if runtime_save_dir and runtime_save_dir.exists():
            runtime_weights_dir = runtime_save_dir / "weights"
            for name in ("best.pt", "last.pt"):
                src = runtime_weights_dir / name
                dst = persisted_weights_dir / name
                if src.exists():
                    try:
                        shutil.copy2(src, dst)
                        os.chmod(dst, 0o666)
                        logger.info(f"RT-DETR copied {name} from {src} to {dst}")
                    except Exception as copy_err:
                        logger.warning(f"RT-DETR could not copy {name}: {copy_err}")

        best_model_path = output_base / "training" / "weights" / "best.pt"
        last_model_path = output_base / "training" / "weights" / "last.pt"

        task.status = "completed"
        task.completed_at = datetime.utcnow()
        task.progress = 100
        task.task_metadata = {
            **(task.task_metadata or {}),
            "stage": "completed",
            "best_model": str(best_model_path) if best_model_path.exists() else None,
            "last_model": str(last_model_path) if last_model_path.exists() else None,
            "results_dir": str(output_base / "training"),
        }
        db.commit()

        return {
            "status": "completed",
            "task_id": task_id,
            "best_model": str(best_model_path) if best_model_path.exists() else None,
        }

    except Exception as e:
        logger.error(f"Error in RT-DETR training task {task_id}: {str(e)}", exc_info=True)
        task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
        if task:
            task_meta = task.task_metadata or {}
            pause_requested = isinstance(task_meta, dict) and bool(task_meta.get("pause_requested_at"))
            stop_requested = isinstance(task_meta, dict) and bool(task_meta.get("stop_requested_at"))
            if task.status in ("paused", "stopped") or pause_requested or stop_requested:
                if pause_requested and task.status != "paused":
                    task.status = "paused"
                    task.task_metadata = {**task_meta, "stage": "paused", "pause_requested_at": None}
                    db.commit()
                if stop_requested and task.status not in ("paused", "stopped"):
                    task.status = "stopped"
                    task.completed_at = datetime.utcnow()
                    task.error_message = "Task stopped by user"
                    task.task_metadata = {**task_meta, "stage": "stopped"}
                    db.commit()
            else:
                task.status = "failed"
                task.completed_at = datetime.utcnow()
                task.error_message = str(e)
                task.task_metadata = {**task_meta, "stage": "failed", "error": str(e)}
                db.commit()
        raise
    finally:
        db.close()
