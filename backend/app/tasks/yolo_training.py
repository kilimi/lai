"""
YOLO training task implementation.
Separated from training_tasks.py for better organization.
"""
import os
import shutil
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, Tuple, Mapping

from app.tasks.training_common import TrainingTask
from app.database import SessionLocal
from app.tasks.yolo_training_helpers import (
    fix_path_permissions_recursive,
    get_runtime_training_project,
    prepare_yolo_training_weights_dir,
)
from app.models import Task as TaskModel
from app.celery.gpu_app import celery_app

logger = logging.getLogger(__name__)


def _trainer_results_metrics_flat(model) -> Dict[str, float]:
    """Best-effort: Ultralytics attaches final val metrics on model.trainer.metrics.results_dict."""
    out: Dict[str, float] = {}
    trainer = getattr(model, "trainer", None)
    if not trainer:
        return out
    raw = getattr(trainer, "metrics", None)
    if raw is None:
        return out
    rd = getattr(raw, "results_dict", None)
    if callable(rd):
        try:
            rd = rd()
        except Exception:
            rd = None
    if rd is None and isinstance(raw, Mapping):
        rd = dict(raw)
    if not isinstance(rd, Mapping):
        return out
    for k, v in rd.items():
        try:
            if isinstance(v, (int, float)) and v == v:
                fv = float(v)
                if abs(fv) != float("inf"):
                    out[str(k)] = fv
        except (TypeError, ValueError):
            continue
    return out


class YOLOTrainingTask(TrainingTask):
    """YOLO training task implementation"""
    
    def __init__(self):
        super().__init__()
        self.task_id: Optional[int] = None
        self.training_config: Optional[Dict[str, Any]] = None
        self.db = None
        self.task: Optional[TaskModel] = None
        self.output_base: Optional[Path] = None
        self.weights_dir: Optional[Path] = None
        self.model = None
        self.results = None
        self.model_path: Optional[str] = None
        self.model_class: str = "yolo"
        self._last_train_args: Optional[Dict[str, Any]] = None
    
    def execute(self, task_id: int, training_config: Dict[str, Any]):
        """
        Main entry point for YOLO training task.
        This method contains the actual training logic.
        """
        logger.info(f"YOLOTrainingTask.execute() called with task_id={task_id}, training_config keys={list(training_config.keys())}")
        
        self.task_id = task_id
        self.training_config = training_config
        self.db = SessionLocal()
        
        try:
            celery_task_id = self.request.id if hasattr(self, 'request') and self.request else 'N/A'
            logger.info(f"Starting YOLO training task {task_id} (Celery task {celery_task_id})")
            logger.info(f"Training config: model_type={training_config.get('model_type')}, epochs={training_config.get('epochs')}, batch_size={training_config.get('batch_size')}")
            
            # Initialize task
            logger.info(f"Step 1: Initializing task {task_id}")
            self._initialize_task()
            logger.info(f"Task {task_id} initialized, status set to running")
            
            # Setup directories
            logger.info(f"Step 2: Setting up directories for task {task_id}")
            self._setup_directories()
            logger.info(f"Directories set up: output_base={self.output_base}, weights_dir={self.weights_dir}")
            
            # Prepare dataset
            logger.info(f"Step 3: Preparing dataset for task {task_id}")
            dataset_info = self._prepare_dataset()
            logger.info(f"Dataset prepared: {len(dataset_info.get('class_names', []))} classes, {dataset_info.get('image_counts', {})}")
            
            # Create training examples visualization
            logger.info(f"Step 3.5: Creating training examples visualization for task {task_id}")
            self._create_training_examples(dataset_info)
            logger.info(f"Training examples created")
            
            # Load model
            logger.info(f"Step 4: Loading YOLO model for task {task_id}")
            self._load_model()
            logger.info(f"Model loaded: {self.model}")
            
            # Setup training arguments
            logger.info(f"Step 5: Building training arguments for task {task_id}")
            train_args = self._build_training_args(dataset_info)
            logger.info(f"Training args prepared: project={train_args.get('project')}, epochs={train_args.get('epochs')}")
            
            # Train model
            logger.info(f"Step 6: Starting model training for task {task_id}")
            logger.info(f"About to call model.train() with args: {list(train_args.keys())}")
            self._train_model(train_args)
            logger.info(f"Model training completed for task {task_id}")
            
            # Handle weights
            logger.info(f"Step 7: Handling weights for task {task_id}")
            self._handle_weights()
            
            # Complete task
            logger.info(f"Step 8: Completing task {task_id}")
            self._complete_task(dataset_info)
            
            logger.info(f"Training completed successfully for task {task_id}")
            
            return {
                "status": "completed",
                "task_id": task_id,
                "best_model": str(self.weights_dir / "best.pt") if (self.weights_dir / "best.pt").exists() else None
            }
            
        except Exception as e:
            logger.error(f"Error in training task {task_id}: {str(e)}", exc_info=True)
            self._handle_error(e)
            raise
        finally:
            if self.db:
                self.db.close()
    
    
    def _initialize_task(self):
        """Initialize task in database"""
        self.task = self.db.query(TaskModel).filter(TaskModel.id == self.task_id).first()
        if not self.task:
            raise ValueError(f"Task {self.task_id} not found")
        
        self.task.status = "running"
        self.task.started_at = datetime.utcnow()
        self.task.progress = 10
        self.task.task_metadata = {
            **(self.task.task_metadata or {}),  # Preserve existing metadata
            "stage": "preparing_dataset",
            "celery_task_id": self.request.id,
            "training_config": self.training_config,
        }
        self.db.commit()
    
    def _setup_directories(self):
        """Create and setup output directories with proper permissions"""
        from app.tasks.yolo_training_helpers import setup_training_directories
        
        project_id = self.training_config['project_id']
        output_paths = setup_training_directories(project_id, self.task_id)
        
        self.output_base = output_paths['output_base']
        self.weights_dir = output_paths['weights_dir']
        
        logger.info(f"Output directory: {self.output_base}")
        logger.info(f"Weights directory: {self.weights_dir}")
    
    def _prepare_dataset(self):
        """Prepare YOLO dataset from database annotations"""
        from app.ml.dataset import prepare_yolo_dataset
        
        logger.info(f"Preparing dataset for task {self.task_id}")
        
        dataset_dir = self.output_base / "dataset"
        model_type = self.training_config.get('model_type', 'yolo11n-seg.pt')
        
        dataset_info = prepare_yolo_dataset(
            self.db,
            self.training_config['dataset_configs'],
            dataset_dir,
            model_type=model_type,
            remove_images_without_annotations=self.training_config.get('remove_images_without_annotations', True)
        )
        
        logger.info(f"Dataset prepared: {dataset_info}")
        
        # Extract stats for cleaner display
        dataset_stats = dataset_info.get('dataset_stats', {})
        logger.info(f"Dataset stats: {dataset_stats}")
        
        self.task.progress = 30
        self.task.task_metadata = {
            **(self.task.task_metadata or {}),  # Preserve existing metadata (including dataset_configs)
            "stage": "dataset_prepared",
            "dataset_info": dataset_info,
            "dataset_stats": {  # Include human-readable stats
                "total_images": dataset_stats.get('total_images', {}),
                "total_annotations": dataset_stats.get('total_annotations', {}),
                "annotations_per_class": dataset_stats.get('annotations_per_class', {}),
                "images_filtered": dataset_stats.get('images_filtered', 0),
                "images_processed": dataset_stats.get('images_processed', 0),
            },
            "celery_task_id": self.request.id
        }
        self.db.commit()
        
        return dataset_info
    
    def _create_training_examples(self, dataset_info: Dict[str, Any]):
        """Create visualization examples of training data with annotations"""
        from app.tasks.training_visualization import (
            create_classification_training_examples,
            create_training_examples,
        )

        try:
            dataset_dir = self.output_base / "dataset"
            examples_dir = self.output_base / "examples"

            class_names = dataset_info.get("class_names", [])
            model_type = self.training_config.get("model_type", "yolo11n-seg.pt")
            is_segmentation = "-seg" in model_type.lower()
            is_classification = "-cls" in model_type.lower() or dataset_info.get("dataset_format") == "classify"

            if is_classification:
                logger.info(
                    "Creating classification training examples — dataset dir: %s",
                    dataset_dir,
                )
                create_classification_training_examples(
                    dataset_dir=dataset_dir,
                    output_dir=examples_dir,
                    class_names=list(class_names),
                    num_examples=16,
                    grid_size=(4, 4),
                )
            else:
                logger.info(
                    "Creating training examples — model_type: %s, is_seg: %s",
                    model_type,
                    is_segmentation,
                )
                create_training_examples(
                    dataset_dir=dataset_dir,
                    output_dir=examples_dir,
                    class_names=class_names,
                    num_examples=16,
                    is_segmentation=is_segmentation,
                    grid_size=(4, 4),
                )

            logger.info(f"Training examples created successfully in {examples_dir}")

            example_images = {}
            for split in ["train", "val", "test"]:
                example_path = examples_dir / f"{split}_batch.jpg"
                if example_path.exists():
                    example_images[split] = f"/tasks/{self.task_id}/examples/{split}"

            self.task.task_metadata = {
                **self.task.task_metadata,
                "examples_path": str(examples_dir),
                "example_images": example_images,
            }
            self.db.commit()

        except Exception as e:
            logger.warning(f"Failed to create training examples: {e}", exc_info=True)
    
    def _load_model(self):
        """Resolve model weights path for the Ultralytics subprocess."""
        model_type = self.training_config.get('model_type', 'yolo11n-seg.pt')
        resume_from = self.training_config.get('resume_from')

        if resume_from and Path(resume_from).exists():
            logger.info(f"Resuming YOLO from checkpoint: {resume_from}")
            load_path = resume_from
        else:
            if resume_from:
                logger.warning(
                    f"resume_from path not found ({resume_from}), loading base model instead"
                )
            logger.info(f"Preparing YOLO model path: {model_type}")
            from app.ml.ultralytics_compat import assert_ultralytics_supports_model
            from app.model_weights_presence import resolve_training_base_weights_path

            assert_ultralytics_supports_model(model_type)

            resolved = resolve_training_base_weights_path(model_type)
            if resolved:
                load_path = str(resolved)
                logger.info(f"Resolved base weights: {load_path}")
            else:
                model_path = Path(model_type)
                load_path = str(model_path) if model_path.exists() else model_type

        self.model_path = str(load_path)
        self.model_class = "yolo"
        total_epochs = self.training_config.get('epochs', 100)

        self.task.progress = 40
        self.task.task_metadata = {
            **self.task.task_metadata,
            "stage": "training",
            "model_loaded": self.model_path,
            "total_epochs": total_epochs,
        }
        self.db.commit()
    
    def _build_training_args(self, dataset_info: Dict[str, Any]) -> Dict[str, Any]:
        """Build training arguments dictionary"""
        from app.tasks.yolo_training_helpers import build_yolo_training_args
        
        # Run training in container-local /tmp to avoid bind-mount EPERM on
        # repeated checkpoint writes (last.pt) under /app/projects.
        project_path = get_runtime_training_project(self.task_id)
        logger.info(f"Setting YOLO runtime project to: {project_path}")
        logger.info(f"Expected persisted output base: {self.output_base.resolve()}")
        logger.info(f"Dataset info keys: {list(dataset_info.keys())}")
        logger.info(f"Dataset yaml_path: {dataset_info.get('yaml_path')}")
        
        train_args = build_yolo_training_args(
            dataset_info,
            self.training_config,
            project_path,
            self.task_id
        )
        
        logger.info(f"Built training args with keys: {list(train_args.keys())}")
        logger.info(f"Starting training with args: {train_args}")
        logger.info(f"IMAGE SIZE EXPLICITLY SET TO: {train_args.get('imgsz', 'NOT SET')}")

        # When resuming from a checkpoint, tell YOLO to continue from last.pt
        if self.training_config.get('resume_from'):
            train_args['resume'] = True
            logger.info(f"Resume mode: added resume=True to train_args")

        # Verify critical paths exist
        data_path = Path(train_args.get('data', ''))
        if dataset_info.get('dataset_format') == 'classify':
            if not (data_path / 'train').is_dir():
                raise FileNotFoundError(
                    f"Classification dataset train/ folder does not exist: {data_path}"
                )
            logger.info(f"Verified classification dataset root: {data_path}")
        elif not data_path.exists():
            raise FileNotFoundError(f"Data YAML file does not exist: {data_path}")
        else:
            logger.info(f"Verified data.yaml exists: {data_path}")
        
        project_dir = Path(train_args.get('project', ''))
        if not project_dir.exists():
            logger.warning(f"Project directory does not exist: {project_dir}, will be created by YOLO")
        else:
            logger.info(f"Project directory exists: {project_dir}")
        
        return train_args
    
    def _train_model(self, train_args: Dict[str, Any]):
        """Execute YOLO model training in the Ultralytics venv subprocess."""
        from app.ml.ultralytics_subprocess import run_ultralytics_training_subprocess

        logger.info(
            "Starting YOLO subprocess training project=%s name=%s",
            train_args.get("project"),
            train_args.get("name"),
        )
        self._last_train_args = dict(train_args)

        if self.output_base:
            try:
                prepare_yolo_training_weights_dir(self.output_base)
            except PermissionError:
                raise
            except Exception as e:
                logger.warning(f"prepare_yolo_training_weights_dir failed: {e}")

        data_yaml_path = Path(train_args.get("data", ""))
        if not data_yaml_path.exists():
            raise FileNotFoundError(f"Data YAML file does not exist: {data_yaml_path}")

        if not self.model_path:
            raise ValueError("model_path not set — call _load_model() first")

        total_epochs = self.training_config.get("epochs", 100)
        device = str(self.training_config.get("device", "0"))

        old_umask = os.umask(0)
        try:
            run_ultralytics_training_subprocess(
                model_class=self.model_class,
                model_path=self.model_path,
                train_args=train_args,
                task_runner=self,
                task_id=self.task_id,
                total_epochs=total_epochs,
                device=device,
            )
            if self.weights_dir and self.weights_dir.exists():
                try:
                    fix_path_permissions_recursive(self.weights_dir)
                    for weight_file in self.weights_dir.rglob("*.pt"):
                        try:
                            os.chmod(weight_file, 0o666)
                        except Exception as e:
                            logger.warning(f"Could not fix permissions on {weight_file}: {e}")
                except Exception as e:
                    logger.warning(f"Could not fix permissions after training: {e}")
        finally:
            os.umask(old_umask)
    
    def _handle_weights(self):
        """Handle weight files after training"""
        from app.tasks.yolo_training_helpers import (
            get_yolo_save_directory,
            copy_weights_to_expected_location
        )
        
        actual_save_dir = None
        if self._last_train_args:
            project = self._last_train_args.get("project")
            name = self._last_train_args.get("name", "training")
            if project:
                candidate = Path(project) / name
                if candidate.exists():
                    actual_save_dir = candidate
        if actual_save_dir is None:
            actual_save_dir = get_yolo_save_directory(self.model, self.results)
        
        self.task.progress = 90
        self.task.task_metadata = {
            **self.task.task_metadata,
            "stage": "training_completed",
            "results_saved": str(self.output_base / "training"),
            "yolo_actual_save_dir": str(actual_save_dir) if actual_save_dir else None
        }
        self.db.commit()
        
        # Copy weights to expected location
        logger.info(
            "Post-train: copy_weights_to_expected_location "
            f"(actual_save_dir={actual_save_dir}, weights_dir={self.weights_dir})"
        )
        weights_info = copy_weights_to_expected_location(
            actual_save_dir,
            self.weights_dir,
            self.output_base
        )

        from app.tasks.yolo_training_helpers import sync_training_run_artifacts
        from sqlalchemy.orm.attributes import flag_modified

        from app.tasks.yolo_metrics import finalize_yolo_metrics

        persist_training_dir = self.output_base / "training"
        artifact_info = sync_training_run_artifacts(actual_save_dir, persist_training_dir)
        results_csv = Path(artifact_info.get("results_csv", ""))
        if not results_csv.is_file() and actual_save_dir:
            results_csv = actual_save_dir / "results.csv"

        meta = dict(self.task.task_metadata or {})
        history = meta.get("metrics_history") if isinstance(meta.get("metrics_history"), list) else []
        metrics_history, latest_metrics, results_summary = finalize_yolo_metrics(
            history,
            results_csv=results_csv if results_csv.is_file() else None,
        )

        # Store weights info in task metadata
        self.task.task_metadata.update(weights_info)
        self.task.task_metadata.update(artifact_info)
        if metrics_history:
            self.task.task_metadata["metrics_history"] = metrics_history
        if latest_metrics:
            self.task.task_metadata["latest_metrics"] = latest_metrics
        if results_summary:
            self.task.task_metadata["results"] = {"metrics": results_summary}
        if not self.task.task_metadata.get("device_used"):
            device = str(self.training_config.get("device", "0"))
            self.task.task_metadata["device_used"] = (
                f"cuda:{device}" if device not in ("", "cpu") else "cpu"
            )
        flag_modified(self.task, "task_metadata")
        self.db.commit()

        # Copy training results to Windows-accessible location
        self._export_training_results(actual_save_dir)
    
    def _export_training_results(self, actual_save_dir: Path):
        """Export training results (weights, plots, metrics) to backups directory for easy access"""
        try:
            # Create export directory in backups (Windows-accessible)
            export_dir = Path("backups") / "training_exports" / f"task_{self.task_id}"
            export_dir.mkdir(parents=True, exist_ok=True)
            
            logger.info(f"Exporting training results to {export_dir}")
            
            # Copy weights
            for weight_name in ["best.pt", "last.pt"]:
                source = self.weights_dir / weight_name
                if source.exists():
                    shutil.copy2(source, export_dir / weight_name)
                    logger.info(f"✓ Exported {weight_name}")
            
            # Copy results files (plots, metrics, CSV)
            if actual_save_dir and actual_save_dir.exists():
                for pattern in ["*.png", "*.csv", "results.json", "args.yaml"]:
                    for file in actual_save_dir.glob(pattern):
                        shutil.copy2(file, export_dir / file.name)
                        logger.info(f"✓ Exported {file.name}")
            
            # Create README with task info
            readme_path = export_dir / "README.txt"
            with open(readme_path, 'w') as f:
                f.write(f"Training Task #{self.task_id}\n")
                f.write(f"{'='*50}\n\n")
                f.write(f"Exported: {datetime.utcnow().isoformat()}\n")
                f.write(f"Model: {self.training_config.get('model_type', 'unknown')}\n")
                f.write(f"Epochs: {self.training_config.get('epochs', 'unknown')}\n")
                f.write(f"\nFiles in this directory:\n")
                f.write(f"  - best.pt: Best model weights (lowest validation loss)\n")
                f.write(f"  - last.pt: Final epoch weights\n")
                f.write(f"  - *.png: Training plots and visualizations\n")
                f.write(f"  - results.csv: Training metrics per epoch\n")
                f.write(f"\nOriginal location (Docker volume):\n")
                f.write(f"  {self.output_base / 'training'}\n")
            
            logger.info(f"✓ Training results exported to: {export_dir}")
            
            # Update task metadata with export location
            self.task.task_metadata["exported_to"] = str(export_dir)
            self.db.commit()
            
        except Exception as e:
            logger.warning(f"Could not export training results: {e}")
            # Don't fail the task if export fails
    
    def _complete_task(self, dataset_info: Dict[str, Any]):
        """Mark task as completed and update metadata"""
        best_model_path = self.weights_dir / "best.pt"
        last_model_path = self.weights_dir / "last.pt"
        
        self.task.status = "completed"
        self.task.completed_at = datetime.utcnow()
        self.task.progress = 100
        trainer_metrics = _trainer_results_metrics_flat(self.model) if self.model else {}
        merged_meta = {
            **self.task.task_metadata,
            "stage": "completed",
            "best_model": str(best_model_path) if best_model_path.exists() else None,
            "last_model": str(last_model_path) if last_model_path.exists() else None,
            "class_names": dataset_info['class_names'],
            "class_count": dataset_info['class_count'],
            "image_counts": dataset_info['image_counts'],
            "results_dir": str(self.output_base / "training"),
        }
        if trainer_metrics and not merged_meta.get("results"):
            merged_meta["results"] = {"metrics": trainer_metrics}
        self.task.task_metadata = merged_meta
        self.db.commit()
    
    def _handle_error(self, error: Exception):
        """Handle training errors"""
        if self.task:
            # Refresh from DB — status or metadata may indicate a user-requested stop.
            self.db.refresh(self.task)
            task_meta = self.task.task_metadata or {}
            pause_requested = isinstance(task_meta, dict) and bool(task_meta.get("pause_requested_at"))
            stop_requested = isinstance(task_meta, dict) and bool(task_meta.get("stop_requested_at"))
            if self.task.status in ('stopped', 'paused') or pause_requested or stop_requested:
                if pause_requested and self.task.status != 'paused':
                    self.task.status = 'paused'
                    self.task.task_metadata = {
                        **task_meta,
                        "stage": "paused",
                        "pause_requested_at": None,
                    }
                    self.db.commit()
                if stop_requested and self.task.status not in ('stopped', 'paused'):
                    self.task.status = 'stopped'
                    self.task.completed_at = datetime.utcnow()
                    self.task.error_message = 'Task stopped by user'
                    self.task.task_metadata = {
                        **task_meta,
                        "stage": "stopped",
                    }
                    self.db.commit()
                logger.info(f"Task {self.task_id} stop/pause detected, not overwriting to 'failed'")
                # Still try to record checkpoint paths if the epoch callback didn't get a chance
                self._save_checkpoint_paths_to_metadata()
                return
            self.task.status = "failed"
            self.task.completed_at = datetime.utcnow()
            self.task.error_message = str(error)
            self.task.task_metadata = {
                **(self.task.task_metadata or {}),
                "stage": "failed",
                "error": str(error)
            }
            # Even on failure, record any checkpoints that were saved
            self._save_checkpoint_paths_to_metadata()
            self.db.commit()

    def _save_checkpoint_paths_to_metadata(self):
        """Record best.pt / last.pt paths into task_metadata if the files exist."""
        if not self.task:
            return
        try:
            checkpoint_meta = {}
            # Check weights_dir (copied location) first, then YOLO runtime save_dir
            for name, key, resume_key in [
                ("best.pt", "best_model", None),
                ("last.pt", "last_model", "resume_from"),
            ]:
                # Already set by epoch callback — don't overwrite
                if self.task.task_metadata and self.task.task_metadata.get(key):
                    continue
                # Try weights_dir
                if self.weights_dir:
                    p = self.weights_dir / name
                    if p.exists():
                        checkpoint_meta[key] = str(p)
                        if resume_key:
                            checkpoint_meta[resume_key] = str(p)
                        continue
                # Try YOLO runtime save_dir via model.trainer
                if self.model and hasattr(self.model, 'trainer') and self.model.trainer:
                    trainer = self.model.trainer
                    if hasattr(trainer, 'save_dir') and trainer.save_dir:
                        p = Path(trainer.save_dir) / 'weights' / name
                        if p.exists():
                            checkpoint_meta[key] = str(p)
                            if resume_key:
                                checkpoint_meta[resume_key] = str(p)
            if checkpoint_meta:
                self.task.task_metadata = {
                    **(self.task.task_metadata or {}),
                    **checkpoint_meta,
                }
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(self.task, "task_metadata")
                self.db.commit()
                logger.info(f"Task {self.task_id}: saved checkpoint paths to metadata: {list(checkpoint_meta.keys())}")
        except Exception as e:
            logger.warning(f"Could not save checkpoint paths: {e}")


# Register as Celery task with the original name for backward compatibility
@celery_app.task(base=YOLOTrainingTask, bind=True, name='app.tasks.training_tasks.train_yolo_model')
def train_yolo_model(self, task_id: int, training_config: Dict[str, Any]):
    """
    Celery task wrapper for YOLO training.
    This is the entry point called by Celery.
    When bind=True, 'self' is the task instance (YOLOTrainingTask).
    Uses the original task name for backward compatibility.
    """
    logger.info(f"=== train_yolo_model() called by Celery ===")
    logger.info(f"Task ID: {task_id}, Training config keys: {list(training_config.keys())}")
    logger.info(f"Self type: {type(self)}, has execute: {hasattr(self, 'execute')}")
    
    # Force log flush immediately
    import sys
    sys.stdout.flush()
    sys.stderr.flush()
    for handler in logger.handlers:
        handler.flush()
    
    # self is already an instance of YOLOTrainingTask
    try:
        logger.info(f"About to call self.execute() for task {task_id}")
        result = self.execute(task_id, training_config)
        logger.info(f"=== train_yolo_model() completed successfully ===")
        return result
    except Exception as e:
        logger.error(f"=== train_yolo_model() failed with exception ===")
        logger.error(f"Exception: {e}", exc_info=True)
        logger.error(f"Exception type: {type(e)}")
        logger.error(f"Exception args: {e.args}")
        raise
