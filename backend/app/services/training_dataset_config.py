"""Helpers for normalizing training dataset configuration from task metadata."""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def normalize_training_dataset_config(config: Any) -> Optional[Dict[str, Any]]:
    """
    Normalize a dataset config entry from task metadata for training/rerun.

    AnnotationFile.id is a string UUID — it must never be coerced to int.
    """
    if not isinstance(config, dict):
        return None

    dataset_id = config.get("dataset_id")
    annotation_file_id = config.get("annotation_file_id")
    if not dataset_id or annotation_file_id is None:
        return None

    try:
        dataset_id = int(dataset_id)
    except (ValueError, TypeError):
        return None

    annotation_file_id = str(annotation_file_id).strip()
    if not annotation_file_id:
        return None

    return {
        "dataset_id": dataset_id,
        "annotation_file_id": annotation_file_id,
        "image_collection": config.get("image_collection"),
        "split": config.get("split", {"train": 80, "val": 20, "test": 0}),
    }


def reconstruct_dataset_configs_from_metadata(
    dataset_configs: Any,
) -> List[Dict[str, Any]]:
    """
    Rebuild training dataset_configs from persisted task metadata (YOLO/MMYOLO rerun).

    Returns an empty list when every entry is invalid — callers may fall back to
    dataset_ids heuristics, which can pick the wrong annotation file.
    """
    if not dataset_configs or not isinstance(dataset_configs, list):
        return []

    reconstructed: List[Dict[str, Any]] = []
    for config in dataset_configs:
        normalized = normalize_training_dataset_config(config)
        if normalized:
            reconstructed.append(normalized)
    return reconstructed
