"""Training task classification and shared helpers."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.models import Task

TRAINING_TASK_TYPES = frozenset({"yolo_training", "training", "mmyolo_training"})


def is_training_task(task: Task) -> bool:
    return task.task_type in TRAINING_TASK_TYPES


def is_mmyolo_training_task(task: Task) -> bool:
    if task.task_type == "mmyolo_training":
        return True
    metadata = task.task_metadata or {}
    if metadata.get("dji_patch_path") or metadata.get("config_id") or metadata.get("arch"):
        return True
    try:
        from app.ml.registry import get_backend_for_task

        return get_backend_for_task(task).runtime_profile == "mmyolo"
    except Exception:
        return False


def checkpoint_stem(checkpoint: str) -> str:
    for ext in (".pth", ".pt"):
        if checkpoint.lower().endswith(ext):
            return checkpoint[: -len(ext)]
    return checkpoint


def weights_search_dir(results_dir: str | Path) -> Optional[Path]:
    root = Path(results_dir)
    weights_sub = root / "weights"
    if weights_sub.is_dir():
        return weights_sub
    return root if root.is_dir() else None


def model_download_arcname(model_path: Path, checkpoint: str, task: Task) -> str:
    if is_mmyolo_training_task(task):
        if model_path.suffix.lower() == ".pth":
            return model_path.name
        return f"{checkpoint_stem(checkpoint)}.pth"
    if model_path.suffix.lower() == ".pt":
        return model_path.name
    return f"{checkpoint_stem(checkpoint)}.pt"


def extract_class_names(task_metadata: Dict[str, Any]) -> List[str]:
    if isinstance(task_metadata.get("class_names"), list):
        return [str(c) for c in task_metadata["class_names"]]
    ds_info = task_metadata.get("dataset_info") or {}
    if isinstance(ds_info, dict) and isinstance(ds_info.get("class_names"), list):
        return [str(c) for c in ds_info["class_names"]]
    return []
