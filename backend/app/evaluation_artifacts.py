"""
Large evaluation payloads (predictions, GT list, CM samples) are stored on disk
as gzip-compressed JSON so task_metadata stays small for fast DB reads.
"""
from __future__ import annotations

import gzip
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

ARTIFACT_FORMAT_VERSION = 1


def evaluation_blobs_file(project_id: int, task_id: int) -> Path:
    return Path("projects") / str(project_id) / "evaluations" / f"task_{task_id}" / "blobs.json.gz"


def write_evaluation_blobs(
    project_id: int,
    task_id: int,
    predictions: List[Dict[str, Any]],
    all_ground_truth: List[Dict[str, Any]],
    confusion_matrix_samples: Dict[str, Any],
) -> str:
    """
    Write blobs next to other project files. Returns path string (relative, posix) stored in task metadata.
    """
    path = evaluation_blobs_file(project_id, task_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "format_version": ARTIFACT_FORMAT_VERSION,
        "predictions": predictions,
        "all_ground_truth": all_ground_truth,
        "confusion_matrix_samples": confusion_matrix_samples,
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with gzip.open(path, "wb", compresslevel=6) as f:
        f.write(raw)
    return path.as_posix()


def read_evaluation_blobs_relative(rel_path: str) -> Optional[Dict[str, Any]]:
    path = Path(rel_path)
    if not path.is_file():
        logger.warning("Evaluation blobs file missing: %s", path)
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error("Failed to read evaluation blobs %s: %s", path, e, exc_info=True)
        return None


def load_merged_evaluation_results(results: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Return results with predictions, all_ground_truth, confusion_matrix_samples populated.
    Legacy tasks keep these keys inline; new tasks load from artifacts['blobs'].
    """
    if not results:
        return {}
    out = dict(results)
    if out.get("predictions") is not None:
        return out
    artifacts = out.get("artifacts") or {}
    rel = artifacts.get("blobs")
    if not rel:
        return out
    data = read_evaluation_blobs_relative(rel)
    if not data:
        return out
    out["predictions"] = data.get("predictions", [])
    out["all_ground_truth"] = data.get("all_ground_truth", [])
    out["confusion_matrix_samples"] = data.get("confusion_matrix_samples", {})
    return out
