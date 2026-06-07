"""
Helper functions for YOLO training.
These functions break down the training logic into smaller, testable units.
"""
import os
import shutil
import logging
from datetime import datetime
from pathlib import Path
from time import monotonic
from typing import Dict, Any, Optional

from app.models import Task as TaskModel

logger = logging.getLogger(__name__)


class ProgressCallback:
    """Callback for YOLO training progress updates"""
    
    def __init__(self, celery_task, task_id: int, total_epochs: int, db_session):
        self.celery_task = celery_task
        self.task_id = task_id
        self.total_epochs = total_epochs
        self.current_epoch = 0
        self.current_batch = 0
        self.total_batches = 0
        self.db = db_session
        self.metrics_history = []
        self._epoch_started_at: Optional[float] = None
        self._last_batch_update_at: float = 0.0
        self._last_published_batch: int = -1

    def on_train_batch_end(self, trainer):
        """Publish coarse in-epoch batch progress so the UI does not look stalled."""
        try:
            epoch = int(getattr(trainer, 'epoch', 0)) + 1
            current_batch = int(getattr(trainer, 'batch_i', -1)) + 1
            total_batches = self._resolve_total_batches(trainer)
            if current_batch <= 0 or total_batches is None or total_batches <= 0:
                return

            if epoch != self.current_epoch:
                self.current_epoch = epoch
                self._epoch_started_at = monotonic()
                self._last_published_batch = -1

            self.current_batch = current_batch
            self.total_batches = total_batches

            now = monotonic()
            should_publish = (
                current_batch == 1
                or current_batch == total_batches
                or current_batch - self._last_published_batch >= 2
                or now - self._last_batch_update_at >= 30
            )
            if not should_publish:
                return

            self._last_published_batch = current_batch
            self._last_batch_update_at = now

            epoch_fraction = current_batch / max(total_batches, 1)
            overall_fraction = ((epoch - 1) + epoch_fraction) / max(self.total_epochs, 1)
            progress = 40 + int(overall_fraction * 50)
            epoch_progress_pct = int(epoch_fraction * 100)

            epoch_eta_seconds = None
            if self._epoch_started_at is not None and current_batch > 0:
                elapsed = max(now - self._epoch_started_at, 0.0)
                avg_batch_seconds = elapsed / current_batch
                epoch_eta_seconds = int(max(total_batches - current_batch, 0) * avg_batch_seconds)

            self._publish_batch_progress(
                progress=progress,
                epoch=epoch,
                current_batch=current_batch,
                total_batches=total_batches,
                epoch_progress_pct=epoch_progress_pct,
                epoch_eta_seconds=epoch_eta_seconds,
            )
        except Exception as e:
            logger.debug(f"Ignoring YOLO batch progress callback error for task {self.task_id}: {e}")
    
    def on_train_epoch_end(self, trainer):
        """Called at the end of each training epoch"""
        self.current_epoch = trainer.epoch + 1
        progress = 40 + int((self.current_epoch / self.total_epochs) * 50)
        
        # Extract metrics
        metrics = self._extract_metrics(trainer)
        self.metrics_history.append(metrics)
        
        # Update task in database
        self._update_task_progress(progress, metrics, trainer)

    def _resolve_total_batches(self, trainer) -> Optional[int]:
        train_loader = getattr(trainer, 'train_loader', None)
        if train_loader is not None:
            try:
                total = len(train_loader)
                if total > 0:
                    return int(total)
            except TypeError:
                pass
        total = getattr(trainer, 'nb', None)
        if isinstance(total, int) and total > 0:
            return total
        return None

    def _publish_batch_progress(
        self,
        progress: int,
        epoch: int,
        current_batch: int,
        total_batches: int,
        epoch_progress_pct: int,
        epoch_eta_seconds: Optional[int],
    ):
        task = self.db.query(TaskModel).filter(TaskModel.id == self.task_id).first()
        if not task:
            return

        task_meta = task.task_metadata or {}
        stop_requested = isinstance(task_meta, dict) and bool(task_meta.get("stop_requested_at"))
        if task.status in ('stopped', 'paused') or stop_requested:
            return

        stage = task_meta.get("stage") if isinstance(task_meta, dict) else None
        if stage != "pause_requested":
            stage = "training"

        task.progress = min(progress, 90)
        task.task_metadata = {
            **task_meta,
            "stage": stage,
            "current_epoch": epoch,
            "total_epochs": self.total_epochs,
            "current_batch": current_batch,
            "total_batches": total_batches,
            "epoch_progress_pct": epoch_progress_pct,
            "epoch_eta_seconds": epoch_eta_seconds,
            "last_batch_update_at": datetime.utcnow().isoformat(),
        }
        self.db.commit()

        self.celery_task.update_state(
            state='PROGRESS',
            meta={
                'current': epoch,
                'total': self.total_epochs,
                'progress': task.progress,
                'status': f'Training epoch {epoch}/{self.total_epochs} batch {current_batch}/{total_batches}',
                'batch': current_batch,
                'batches': total_batches,
                'epoch_progress_pct': epoch_progress_pct,
                'epoch_eta_seconds': epoch_eta_seconds,
            }
        )
    
    def _extract_metrics(self, trainer) -> Dict[str, Any]:
        """Extract metrics from trainer"""
        metrics = {}
        
        try:
            # Get loss items
            losses = self._extract_losses(trainer)
            
            # Get validation metrics
            val_metrics = self._extract_validation_metrics(trainer)
            
            # Build metrics dictionary
            metrics = {
                'epoch': self.current_epoch,
                **losses,
                **val_metrics,
                'lr0': self._get_learning_rate(trainer, 0),
                'lr1': self._get_learning_rate(trainer, 1),
                'lr2': self._get_learning_rate(trainer, 2),
            }
            
            logger.info(f"Epoch {self.current_epoch} metrics: {metrics}")
        except Exception as e:
            logger.warning(f"Could not extract metrics: {e}", exc_info=True)
        
        return metrics
    
    def _extract_losses(self, trainer) -> Dict[str, float]:
        """Extract loss values from trainer"""
        losses = {}
        
        if hasattr(trainer, 'loss_items') and trainer.loss_items is not None:
            loss_names = ['box_loss', 'cls_loss', 'dfl_loss']
            
            # Check if it's a segmentation model
            if hasattr(trainer, 'model') and hasattr(trainer.model, 'model'):
                model_yaml = str(trainer.args.model).lower() if hasattr(trainer, 'args') else ''
                if 'seg' in model_yaml:
                    loss_names.append('seg_loss')
            
            for i, name in enumerate(loss_names):
                if i < len(trainer.loss_items):
                    losses[name] = float(trainer.loss_items[i])
        
        return losses
    
    def _extract_validation_metrics(self, trainer) -> Dict[str, float]:
        """Extract validation metrics from trainer"""
        val_metrics = {}
        
        if hasattr(trainer, 'metrics') and trainer.metrics:
            metrics_data = trainer.metrics
            
            # Log available keys for debugging (only first epoch)
            if self.current_epoch == 1:
                logger.info(f"Available metric keys: {list(metrics_data.keys())}")
            
            # Extract validation metrics
            for key in metrics_data.keys():
                if 'precision' in key.lower():
                    val_metrics['precision'] = float(metrics_data[key])
                elif 'recall' in key.lower():
                    val_metrics['recall'] = float(metrics_data[key])
                elif 'map50-95' in key.lower() or 'map@50:95' in key.lower():
                    val_metrics['mAP50_95'] = float(metrics_data[key])
                elif 'map50' in key.lower() or 'map@50' in key.lower():
                    val_metrics['mAP50'] = float(metrics_data[key])
        
        return val_metrics
    
    def _get_learning_rate(self, trainer, group_index: int) -> float:
        """Get learning rate for optimizer parameter group"""
        if hasattr(trainer, 'optimizer') and hasattr(trainer.optimizer, 'param_groups'):
            if len(trainer.optimizer.param_groups) > group_index:
                return float(trainer.optimizer.param_groups[group_index]['lr'])
        return 0.0
    
    def _update_task_progress(self, progress: int, metrics: Dict[str, Any], trainer):
        """Update task progress in database and Celery"""
        try:
            task = self.db.query(TaskModel).filter(TaskModel.id == self.task_id).first()
            if task:
                task_meta = task.task_metadata or {}
                pause_requested = isinstance(task_meta, dict) and bool(task_meta.get("pause_requested_at"))
                stop_requested = isinstance(task_meta, dict) and bool(task_meta.get("stop_requested_at"))

                # Check if task has been stopped/paused or stop was requested.
                if task.status in ('stopped', 'paused') or pause_requested or stop_requested:
                    if task.status == 'paused' or pause_requested:
                        final_stage = 'paused'
                        if task.status != 'paused':
                            task.status = 'paused'
                    else:
                        final_stage = 'stopped'
                        if task.status != 'stopped':
                            task.status = 'stopped'
                            task.completed_at = datetime.utcnow()
                            task.error_message = 'Task stopped by user'

                    logger.info(f"Task {self.task_id} entering stage='{final_stage}', stopping training loop")
                    last_pt_path = self._find_last_pt(trainer)
                    best_pt_path = self._find_best_pt(trainer)
                    updated_meta = {
                        **task_meta,
                        "current_epoch": self.current_epoch,
                        "stage": final_stage,
                        "latest_metrics": metrics,
                        "metrics_history": self.metrics_history,
                        "pause_requested_at": None,
                    }
                    if last_pt_path:
                        updated_meta["resume_from"] = str(last_pt_path)
                        updated_meta["last_model"] = str(last_pt_path)
                        updated_meta["paused_epoch"] = self.current_epoch
                        logger.info(f"Task {self.task_id}: saved resume_from={last_pt_path}")
                    if best_pt_path:
                        updated_meta["best_model"] = str(best_pt_path)
                        logger.info(f"Task {self.task_id}: saved best_model={best_pt_path}")
                    task.task_metadata = updated_meta
                    self.db.commit()
                    trainer.stop = True
                    return
                
                task.progress = min(progress, 90)
                task.task_metadata = {
                    **(task.task_metadata or {}),
                    "current_epoch": self.current_epoch,
                    "total_epochs": self.total_epochs,
                    "stage": "training",
                    "latest_metrics": metrics,
                    "metrics_history": self.metrics_history
                }
                self.db.commit()
                
                # Update Celery task state
                self.celery_task.update_state(
                    state='PROGRESS',
                    meta={
                        'current': self.current_epoch,
                        'total': self.total_epochs,
                        'progress': progress,
                        'status': f'Training epoch {self.current_epoch}/{self.total_epochs}',
                        'metrics': metrics
                    }
                )
                logger.info(f"Task {self.task_id}: Completed epoch {self.current_epoch}/{self.total_epochs}")
        except Exception as e:
            logger.error(f"Error updating progress: {e}")

    def _find_last_pt(self, trainer) -> Optional[Path]:
        """Locate last.pt for the current training run"""
        try:
            if hasattr(trainer, 'last') and trainer.last and Path(trainer.last).exists():
                return Path(trainer.last)
            if hasattr(trainer, 'save_dir') and trainer.save_dir:
                candidate = Path(trainer.save_dir) / 'weights' / 'last.pt'
                if candidate.exists():
                    return candidate
        except Exception as e:
            logger.warning(f"Could not locate last.pt: {e}")
        return None

    def _find_best_pt(self, trainer) -> Optional[Path]:
        """Locate best.pt for the current training run"""
        try:
            if hasattr(trainer, 'best') and trainer.best and Path(trainer.best).exists():
                return Path(trainer.best)
            if hasattr(trainer, 'save_dir') and trainer.save_dir:
                candidate = Path(trainer.save_dir) / 'weights' / 'best.pt'
                if candidate.exists():
                    return candidate
        except Exception as e:
            logger.warning(f"Could not locate best.pt: {e}")
        return None


def setup_training_directories(project_id: int, task_id: int) -> Dict[str, Path]:
    """
    Create and setup training directories with proper permissions.
    
    Returns:
        Dictionary with paths: output_base, training_output_dir, weights_dir
    """
    projects_base = Path("projects")
    project_dir = projects_base / str(project_id)
    training_base = project_dir / "training"
    output_base = training_base / f"task_{task_id}"
    training_output_dir = output_base / "training"
    weights_dir = training_output_dir / "weights"
    
    # Create runs/segment directories (fallback location)
    runs_base = Path("runs")
    runs_segment = runs_base / "segment"
    
    # List of directories to create/fix permissions
    directories_to_setup = [
        runs_base,
        runs_segment,
        projects_base,
        project_dir,
        training_base,
        output_base,
        training_output_dir,
        weights_dir
    ]
    
    # Setup each directory
    for directory in directories_to_setup:
        _setup_directory_permissions(directory)
    
    return {
        'output_base': output_base,
        'training_output_dir': training_output_dir,
        'weights_dir': weights_dir
    }


def _setup_directory_permissions(directory: Path):
    """Setup directory with proper permissions"""
    if directory.exists():
        try:
            os.chmod(directory, 0o777)
            logger.info(f"Fixed permissions on directory: {directory}")
        except Exception as e:
            logger.warning(f"Could not fix permissions on {directory}: {e}")
            _try_fix_ownership(directory)
    else:
        try:
            old_umask = os.umask(0)
            try:
                directory.mkdir(parents=True, exist_ok=True)
                os.chmod(directory, 0o777)
                logger.info(f"Created and set permissions on directory: {directory}")
            finally:
                os.umask(old_umask)
        except Exception as e:
            logger.warning(f"Could not create/fix directory {directory}: {e}")


def _try_fix_ownership(directory: Path):
    """Try to fix directory ownership if running as root"""
    try:
        current_uid = os.getuid()
        if current_uid == 0:
            os.chmod(directory, 0o777)
        else:
            os.chown(directory, current_uid, -1)
            os.chmod(directory, 0o777)
            logger.info(f"Changed ownership and permissions on {directory}")
    except Exception as e:
        logger.warning(f"Could not change ownership on {directory}: {e}")


def fix_path_permissions_recursive(path: Path):
    """
    Walk upward from ``path`` and chmod existing directories to 0o777.

    Must stop when ``.parent`` reaches an anchor (e.g. ``Path('.').parent == Path('.')``).
    Relative paths never reach ``Path('/')`` on POSIX, so the old
    ``while current != Path('/')`` loop could spin forever and stall training at 90%.
    """
    current = path
    fixed_count = 0
    max_steps = 64
    for _ in range(max_steps):
        try:
            if current.exists():
                os.chmod(current, 0o777)
                fixed_count += 1
        except Exception as e:
            logger.warning(f"Could not fix permissions on {current}: {e}")
            break
        parent = current.parent
        if parent == current:
            break
        current = parent
    if fixed_count > 0:
        logger.info(f"Fixed permissions on {fixed_count} directories in path: {path}")


def prepare_yolo_training_weights_dir(output_base: Path) -> Path:
    """
    Ensure output_base/training/weights exists and is writable for Ultralytics
    (last.pt / best.pt), using only fast, targeted operations.

    IMPORTANT: avoid recursive chmod/rmtree here — those can stall on some
    Docker Desktop bind mounts and block the worker before model.train() starts.
    """
    training_dir = output_base / "training"
    weights_dir = training_dir / "weights"
    logger.info("Preparing YOLO weights directory (lightweight mode)")
    training_dir.mkdir(parents=True, exist_ok=True)
    weights_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(training_dir, 0o777)
        os.chmod(weights_dir, 0o777)
    except OSError as e:
        logger.warning(f"chmod on training dirs: {e}")

    # Remove stale checkpoints only (not entire training dir) so writes to
    # last.pt/best.pt won't fail with EPERM from prior runs.
    for pt in ("last.pt", "best.pt"):
        pt_path = weights_dir / pt
        if not pt_path.exists():
            continue
        try:
            os.chmod(pt_path, 0o666)
        except OSError:
            try:
                pt_path.unlink()
            except OSError as e:
                logger.warning(f"Could not fix or remove stale checkpoint {pt_path}: {e}")

    probe = weights_dir / ".write_probe"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as e:
        raise PermissionError(
            f"Cannot write under {weights_dir}. "
            f"On Docker Desktop, ensure the host folder mapped to LAI_DATA_DIR/projects is writable "
            f"by the container (original error: {e})"
        ) from e

    return weights_dir


def get_runtime_training_project(task_id: int) -> Path:
    """
    Return a container-local writable project dir for Ultralytics checkpoints.

    Using /tmp avoids bind-mount permission quirks on Docker Desktop where
    repeated writes to last.pt can fail with EPERM even after chmod.
    """
    runtime_project = Path("/tmp/lai-training") / f"task_{task_id}"
    runtime_project.mkdir(parents=True, exist_ok=True)
    runtime_training = runtime_project / "training"
    runtime_training.mkdir(parents=True, exist_ok=True)
    return runtime_project


def build_yolo_training_args(
    dataset_info: Dict[str, Any],
    training_config: Dict[str, Any],
    project_path: Path,
    task_id: int
) -> Dict[str, Any]:
    """
    Build YOLO training arguments dictionary.
    
    Args:
        dataset_info: Dataset information from prepare_yolo_dataset
        training_config: Training configuration
        project_path: Absolute path to project directory
        task_id: Task ID
    
    Returns:
        Dictionary of training arguments
    """
    # Ensure data.yaml path is absolute
    yaml_path = dataset_info['yaml_path']
    if not Path(yaml_path).is_absolute():
        yaml_path = str(Path(yaml_path).resolve())
        logger.info(f"Converted relative data.yaml path to absolute: {yaml_path}")
    
    # Verify data.yaml exists
    if not Path(yaml_path).exists():
        raise FileNotFoundError(f"Data YAML file not found: {yaml_path}")
    
    logger.info(f"Using data.yaml path: {yaml_path} (exists: {Path(yaml_path).exists()})")

    is_classification = dataset_info.get("dataset_format") == "classify"
    if is_classification:
        data_root = Path(yaml_path)
        if not (data_root / "train").is_dir():
            raise FileNotFoundError(
                f"Classification dataset missing train/ folder: {data_root}"
            )
        yaml_path = str(data_root)
        logger.info(f"Using classification dataset root: {yaml_path}")
    
    device = training_config.get('device', '0')
    try:
        import torch
        if device != 'cpu' and not torch.cuda.is_available():
            cuda_err = ""
            if hasattr(torch.cuda, "get_device_capability"):
                try:
                    torch.cuda.is_available()
                except Exception as exc:
                    cuda_err = f" ({exc})"
            logger.warning(
                "CUDA not available for YOLO training%s. torch=%s at %s. "
                "Using device='cpu'. If nvidia-smi works in worker-gpu, rebuild "
                "lai-worker-gpu (Dockerfile.worker-gpu) so /opt/lai does not shadow the "
                "base CUDA PyTorch wheel, and set CUDA_VISIBLE_DEVICES=0.",
                cuda_err,
                getattr(torch, "__version__", "?"),
                getattr(torch, "__file__", "?"),
            )
            device = 'cpu'
    except Exception:
        pass
    train_args = {
        'data': yaml_path,  # Use absolute path
        'epochs': training_config.get('epochs', 100),
        'batch': training_config.get('batch_size', 16),
        'imgsz': training_config.get('image_size', 640),
        'device': device,
        'patience': training_config.get('patience', 50),
        'optimizer': training_config.get('optimizer', 'auto'),
        'lr0': training_config.get('learning_rate', 0.01),
        'momentum': training_config.get('momentum', 0.937),
        'weight_decay': training_config.get('weight_decay', 0.0005),
        'project': str(project_path),
        'name': 'training',
        'exist_ok': True,
        'save': True,
        'save_period': training_config.get('save_period', -1),
        'verbose': True,
    }
    
    # Add augmentation parameters
    _add_augmentation_args(train_args, training_config)
    
    # Add W&B if enabled
    if training_config.get('use_wandb'):
        train_args['project'] = training_config.get('wandb_project', f"yolo_training_{task_id}")
        if training_config.get('wandb_entity'):
            train_args['entity'] = training_config['wandb_entity']
    
    return train_args


def _add_augmentation_args(train_args: Dict[str, Any], training_config: Dict[str, Any]):
    """Add augmentation parameters to training args"""
    augmentations = training_config.get('augmentations', {})
    if not augmentations:
        return
    
    # Color augmentations
    if augmentations.get('enable_color', True):
        train_args['hsv_h'] = augmentations.get('hsv_h', 0.015)
        train_args['hsv_s'] = augmentations.get('hsv_s', 0.7)
        train_args['hsv_v'] = augmentations.get('hsv_v', 0.4)
    else:
        train_args['hsv_h'] = 0.0
        train_args['hsv_s'] = 0.0
        train_args['hsv_v'] = 0.0
    
    # Geometric augmentations
    if augmentations.get('enable_geometric', True):
        train_args['degrees'] = augmentations.get('degrees', 0.0)
        train_args['translate'] = augmentations.get('translate', 0.1)
        train_args['scale'] = augmentations.get('scale', 0.5)
        train_args['shear'] = augmentations.get('shear', 0.0)
        train_args['perspective'] = augmentations.get('perspective', 0.0)
        train_args['flipud'] = augmentations.get('flipud', 0.0)
        train_args['fliplr'] = augmentations.get('fliplr', 0.5)
    else:
        train_args['degrees'] = 0.0
        train_args['translate'] = 0.0
        train_args['scale'] = 0.0
        train_args['shear'] = 0.0
        train_args['perspective'] = 0.0
        train_args['flipud'] = 0.0
        train_args['fliplr'] = 0.0
    
    # Advanced augmentations
    if augmentations.get('enable_advanced', True):
        train_args['mosaic'] = augmentations.get('mosaic', 1.0)
        train_args['mixup'] = augmentations.get('mixup', 0.0)
        train_args['copy_paste'] = augmentations.get('copy_paste', 0.0)
        if 'auto_augment' in augmentations:
            train_args['auto_augment'] = augmentations['auto_augment']
        train_args['erasing'] = augmentations.get('erasing', 0.4)
        train_args['crop_fraction'] = augmentations.get('crop_fraction', 1.0)
    else:
        train_args['mosaic'] = 0.0
        train_args['mixup'] = 0.0
        train_args['copy_paste'] = 0.0
        train_args['erasing'] = 0.0


def get_yolo_save_directory(model, results) -> Optional[Path]:
    """Get the actual save directory from YOLO trainer or results"""
    if hasattr(model, 'trainer') and hasattr(model.trainer, 'save_dir'):
        save_dir = Path(model.trainer.save_dir)
        logger.info(f"YOLO actual save_dir: {save_dir}")
        return save_dir
    elif hasattr(results, 'save_dir'):
        save_dir = Path(results.save_dir)
        logger.info(f"YOLO actual save_dir from results: {save_dir}")
        return save_dir
    else:
        logger.warning("Could not determine YOLO save_dir from trainer or results")
        return None


def copy_weights_to_expected_location(
    actual_save_dir: Optional[Path],
    weights_dir: Path,
    output_base: Path
) -> Dict[str, Any]:
    """
    Copy weights from YOLO location to expected location.
    
    Returns:
        Dictionary with weights information for task metadata
    """
    # Determine YOLO weights directory
    if actual_save_dir and actual_save_dir.exists():
        yolo_weights_dir = actual_save_dir / "weights"
        logger.info(f"Using actual YOLO save_dir for weights: {yolo_weights_dir}")
    else:
        yolo_weights_dir = weights_dir
        logger.info(f"Using expected location for weights: {yolo_weights_dir}")
    
    # Define weight file paths
    yolo_best_path = yolo_weights_dir / "best.pt"
    yolo_last_path = yolo_weights_dir / "last.pt"
    best_model_path = weights_dir / "best.pt"
    last_model_path = weights_dir / "last.pt"
    
    logger.info(f"Looking for weights:")
    logger.info(f"  YOLO best.pt: {yolo_best_path} (exists: {yolo_best_path.exists()})")
    logger.info(f"  YOLO last.pt: {yolo_last_path} (exists: {yolo_last_path.exists()})")
    logger.info(f"  Expected best.pt: {best_model_path} (exists: {best_model_path.exists()})")
    logger.info(f"  Expected last.pt: {last_model_path} (exists: {last_model_path.exists()})")
    
    # Ensure weights directory exists with proper permissions
    weights_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(weights_dir, 0o777)
        # Chmod parents up to output_base.parent (inclusive), with anchor guard.
        stop = output_base.parent
        current_dir = weights_dir
        for _ in range(64):
            if current_dir.exists():
                os.chmod(current_dir, 0o777)
            if current_dir == stop:
                break
            nxt = current_dir.parent
            if nxt == current_dir:
                break
            current_dir = nxt
        logger.info(f"Ensured weights directory and parents have permissions: {weights_dir}")
    except Exception as e:
        logger.warning(f"Could not set permissions on weights_dir: {e}")
    
    # Copy weights
    weights_copied = False
    weights_copied |= _copy_weight_file(yolo_best_path, best_model_path, "best.pt")
    weights_copied |= _copy_weight_file(yolo_last_path, last_model_path, "last.pt")
    
    # Check if weights exist in expected location (in case YOLO saved there directly)
    if not best_model_path.exists():
        expected_best = output_base / "training" / "weights" / "best.pt"
        if expected_best.exists():
            best_model_path = expected_best
            logger.info(f"Found best.pt in expected location: {best_model_path}")
    
    if not last_model_path.exists():
        expected_last = output_base / "training" / "weights" / "last.pt"
        if expected_last.exists():
            last_model_path = expected_last
            logger.info(f"Found last.pt in expected location: {last_model_path}")
    
    # If weights still not found, use YOLO location directly
    if not best_model_path.exists() and yolo_best_path.exists():
        best_model_path = yolo_best_path
        logger.info(f"Using YOLO location for best.pt: {best_model_path}")
    
    if not last_model_path.exists() and yolo_last_path.exists():
        last_model_path = yolo_last_path
        logger.info(f"Using YOLO location for last.pt: {last_model_path}")
    
    # Last resort: search for weights files
    if not best_model_path.exists() and actual_save_dir:
        best_model_path = _search_for_weight_file(actual_save_dir, "best.pt", best_model_path)
    
    if not last_model_path.exists() and actual_save_dir:
        last_model_path = _search_for_weight_file(actual_save_dir, "last.pt", last_model_path)
    
    # Final check: log all .pt files if weights still don't exist
    if not best_model_path.exists() and not last_model_path.exists() and actual_save_dir:
        _log_all_pt_files(actual_save_dir)
    
    return {
        "best_model": str(best_model_path) if best_model_path.exists() else None,
        "last_model": str(last_model_path) if last_model_path.exists() else None,
        "yolo_best_model": str(yolo_best_path) if yolo_best_path.exists() else None,
        "yolo_last_model": str(yolo_last_path) if yolo_last_path.exists() else None,
        "weights_copied": weights_copied
    }


def sync_training_run_artifacts(
    source_dir: Optional[Path],
    dest_dir: Path,
) -> Dict[str, Any]:
    """
    Copy Ultralytics run outputs (results.csv, plots) into the persisted project tree.

    Training runs in /tmp; this syncs metrics artifacts next to weights under projects/.
    """
    copied: list[str] = []
    if not source_dir or not source_dir.exists():
        return {"artifacts_synced": copied}

    dest_dir.mkdir(parents=True, exist_ok=True)
    for pattern in ("results.csv", "args.yaml", "results.json", "*.png"):
        for src in source_dir.glob(pattern):
            if not src.is_file():
                continue
            try:
                shutil.copy2(src, dest_dir / src.name)
                copied.append(src.name)
            except OSError as exc:
                logger.warning("Could not copy training artifact %s: %s", src, exc)

    return {"artifacts_synced": copied, "results_csv": str(dest_dir / "results.csv")}


def _copy_weight_file(source: Path, destination: Path, weight_name: str) -> bool:
    """Copy a weight file from source to destination"""
    if not source.exists():
        logger.warning(f"✗ YOLO {weight_name} not found at {source}")
        if source.parent.exists():
            files_in_dir = list(source.parent.glob("*"))
            logger.info(f"Files in YOLO weights dir {source.parent}: {[f.name for f in files_in_dir]}")
        return False
    
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(destination.parent, 0o777)
        shutil.copy2(source, destination)
        os.chmod(destination, 0o666)
        logger.info(f"✓ Copied {weight_name} from {source} to {destination}")
        return True
    except Exception as e:
        logger.error(f"✗ Could not copy {weight_name}: {e}", exc_info=True)
        return False


def _search_for_weight_file(search_dir: Path, weight_name: str, default_path: Path) -> Path:
    """Search for weight file in directory and subdirectories"""
    logger.info(f"Searching for {weight_name} in {search_dir} and subdirectories...")
    for weights_file in search_dir.rglob(weight_name):
        logger.info(f"Found {weight_name} at: {weights_file}")
        try:
            shutil.copy2(weights_file, default_path)
            os.chmod(default_path, 0o666)
            logger.info(f"✓ Copied {weight_name} from {weights_file} to {default_path}")
            return default_path
        except Exception as e:
            logger.error(f"Could not copy {weight_name} from {weights_file}: {e}")
    return default_path


def _log_all_pt_files(directory: Path):
    """Log all .pt files found in directory"""
    logger.warning(f"Could not find weights. Searching for all .pt files in {directory}...")
    all_pt_files = list(directory.rglob("*.pt"))
    logger.info(f"Found {len(all_pt_files)} .pt files:")
    for pt_file in all_pt_files:
        logger.info(f"  - {pt_file} ({pt_file.stat().st_size / 1024 / 1024:.2f} MB)")


def generate_safe_output_filename(source_filename: str, dataset_id: int, augmentation_index: int = None, method_suffix: str = None) -> str:
    """
    Generate a safe output filename that includes dataset_id to prevent collisions
    when multiple datasets have files with the same name.
    
    Args:
        source_filename: Original filename (e.g., '0001.jpg')
        dataset_id: ID of the source dataset
        augmentation_index: Optional augmentation iteration index (used for augmented images)
        method_suffix: Optional method suffix for augmented images (e.g., 'crop_flip')
    
    Returns:
        Safe filename with dataset_id embedded (e.g., 'aug_0_crop_flip_ds1_0001.jpg')
    """
    from pathlib import Path
    
    base_name = Path(source_filename).stem
    extension = Path(source_filename).suffix or '.jpg'
    
    if augmentation_index is not None and method_suffix is not None:
        # Augmented image format: aug_{index}_{methods}_ds{dataset_id}_{basename}{ext}
        return f"aug_{augmentation_index}_{method_suffix}_ds{dataset_id}_{base_name}{extension}"
    else:
        # Training image format: ds{dataset_id}_{basename}{ext}
        return f"ds{dataset_id}_{base_name}{extension}"
