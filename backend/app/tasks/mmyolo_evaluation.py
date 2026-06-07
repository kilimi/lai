"""MMYOLO / MMEngine model evaluation helpers."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from app.tasks.training_common import MMYOLO_PYTHON

logger = logging.getLogger(__name__)

MMYOLO_INFERENCE_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "mmyolo_eval_inference.py"
INFERENCE_CHUNK_SIZE = max(1, int(os.environ.get("LAI_MMYOLO_EVAL_CHUNK", "32") or 32))


def resolve_mmyolo_config_path(
    training_task_id: int,
    task_metadata: dict,
    project_id: Optional[int] = None,
) -> Optional[str]:
    """Locate the generated mmyolo_config.py for a training task."""
    config_path = task_metadata.get("config_path")
    if config_path and Path(config_path).exists():
        return str(Path(config_path).resolve())

    resolved_project_id = project_id or task_metadata.get("project_id")
    if resolved_project_id:
        candidate = (
            Path("projects")
            / str(resolved_project_id)
            / "training"
            / f"task_{training_task_id}"
            / "mmyolo_config.py"
        )
        if candidate.exists():
            return str(candidate.resolve())

    return None


def _latest_epoch_checkpoint(results_dir: Path) -> Optional[Path]:
    # MMEngine writes a `last_checkpoint` text file containing the filename of the last saved checkpoint
    last_cp_file = results_dir / "last_checkpoint"
    if last_cp_file.exists():
        try:
            name = last_cp_file.read_text(encoding="utf-8").strip()
            # The file may contain an absolute path or just the basename
            candidate = Path(name) if Path(name).is_absolute() else results_dir / name
            if candidate.exists():
                return candidate
        except Exception:
            pass
    # Fallback: most recently modified epoch_*.pth
    epochs = sorted(
        results_dir.glob("epoch_*.pth"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return epochs[0] if epochs else None


def _find_best_coco_checkpoint(results_dir: Path) -> Optional[Path]:
    """Return the best_coco_*.pth checkpoint from results_dir (newest by mtime)."""
    if not results_dir or not results_dir.exists():
        return None
    bests = sorted(results_dir.glob("best_*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
    return bests[0] if bests else None


def resolve_mmyolo_checkpoint(task_metadata: dict, checkpoint: str) -> Optional[str]:
    """Resolve MMYOLO .pth checkpoint path from training task metadata."""
    results_dir = Path(task_metadata.get("results_dir") or "")
    candidates: List[Path] = []

    if checkpoint == "best":
        best = task_metadata.get("best_model")
        if best:
            candidates.append(Path(best))
        if results_dir:
            # MMYOLO saves best as best_coco_bbox_mAP_epoch_N.pth (or best_*.pth pattern)
            best_coco = _find_best_coco_checkpoint(results_dir)
            if best_coco:
                candidates.append(best_coco)
            candidates.extend(
                [
                    results_dir / "best.pth",
                    results_dir / "epoch_last.pth",
                ]
            )
            latest = _latest_epoch_checkpoint(results_dir)
            if latest:
                candidates.append(latest)
    else:
        last = task_metadata.get("last_model")
        if last:
            candidates.append(Path(last))
        if results_dir:
            candidates.extend(
                [
                    results_dir / "epoch_last.pth",
                    results_dir / "last.pth",
                    results_dir / "best.pth",
                ]
            )
            best_coco = _find_best_coco_checkpoint(results_dir)
            if best_coco:
                candidates.append(best_coco)
            latest = _latest_epoch_checkpoint(results_dir)
            if latest:
                candidates.append(latest)

    for path in candidates:
        if path.exists():
            return str(path.resolve())
    return None


def _build_mmyolo_eval_env(*, device: str, dji_repo_dir: Optional[str]) -> dict:
    """Build subprocess env for MMYOLO inference (avoid LAI PYTHONPATH conflicts)."""
    from app.ml.runtime_env import build_mmyolo_subprocess_env

    return build_mmyolo_subprocess_env(device=device, dji_repo_dir=dji_repo_dir)


def run_mmyolo_inference_subprocess(
    *,
    config_path: str,
    checkpoint_path: str,
    items: List[Tuple[Any, Path]],
    num_classes: int,
    conf_threshold: float,
    device: str,
    dji_repo_dir: Optional[str],
) -> List[Dict[str, Any]]:
    """Run MMYOLO inference in MMYOLO_PYTHON subprocess."""
    if not MMYOLO_INFERENCE_SCRIPT.exists():
        raise FileNotFoundError(f"MMYOLO inference script not found: {MMYOLO_INFERENCE_SCRIPT}")
    if not Path(MMYOLO_PYTHON).exists():
        raise FileNotFoundError(f"MMYOLO_PYTHON not found: {MMYOLO_PYTHON}")

    all_predictions: List[Dict[str, Any]] = []
    env = _build_mmyolo_eval_env(device=device, dji_repo_dir=dji_repo_dir)

    with tempfile.TemporaryDirectory(prefix="mmyolo_eval_") as tmp_dir:
        tmp = Path(tmp_dir)
        for chunk_idx, start in enumerate(range(0, len(items), INFERENCE_CHUNK_SIZE)):
            chunk = items[start : start + INFERENCE_CHUNK_SIZE]
            input_json = tmp / f"input_{chunk_idx}.json"
            output_json = tmp / f"output_{chunk_idx}.json"
            payload = [{"image_id": img.id, "path": str(img_path.resolve())} for img, img_path in chunk]
            input_json.write_text(json.dumps(payload), encoding="utf-8")

            cmd = [
                MMYOLO_PYTHON,
                str(MMYOLO_INFERENCE_SCRIPT),
                "--config",
                str(Path(config_path).resolve()),
                "--checkpoint",
                str(Path(checkpoint_path).resolve()),
                "--input-json",
                str(input_json),
                "--output-json",
                str(output_json),
                "--num-classes",
                str(num_classes),
                "--conf",
                str(conf_threshold),
                "--device",
                device if device not in ("cpu", "") else "cpu",
            ]

            logger.info(
                "MMYOLO inference chunk %s: %s images via %s",
                chunk_idx + 1,
                len(chunk),
                MMYOLO_PYTHON,
            )
            proc = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(Path.cwd()))
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
                raise RuntimeError(f"MMYOLO inference subprocess failed (code {proc.returncode}): {tail}")

            if output_json.exists():
                chunk_preds = json.loads(output_json.read_text(encoding="utf-8"))
                if chunk_preds:
                    all_predictions.extend(chunk_preds)

    return all_predictions


def extract_predictions_from_result(
    result: Any,
    *,
    image_id: int,
    num_classes: int,
    conf_threshold: float,
) -> List[Dict[str, Any]]:
    """Convert MMDet DetDataSample to LAI evaluation prediction dicts."""
    if result is None or not hasattr(result, "pred_instances"):
        return []

    pred_instances = result.pred_instances
    if len(pred_instances) == 0:
        return []

    scores = pred_instances.scores.detach().cpu().numpy()
    labels = pred_instances.labels.detach().cpu().numpy()
    bboxes = pred_instances.bboxes.detach().cpu().numpy()

    predictions: List[Dict[str, Any]] = []
    for score, label, bbox in zip(scores, labels, bboxes):
        if float(score) < conf_threshold:
            continue
        class_id = int(label)
        if class_id < 0 or class_id >= num_classes:
            continue
        x1, y1, x2, y2 = (float(v) for v in bbox[:4])
        predictions.append(
            {
                "image_id": image_id,
                "class_id": class_id,
                "bbox": [x1, y1, x2 - x1, y2 - y1],
                "bbox_xyxy": [x1, y1, x2, y2],
                "conf": float(score),
                "segmentation": [],
            }
        )
    return predictions


def run_mmyolo_inference_on_images(
    model: Any,
    items: List[Tuple[Any, Path]],
    *,
    num_classes: int,
    conf_threshold: float,
) -> List[Dict[str, Any]]:
    """Run per-image MMYOLO inference (requires mmdet in current interpreter)."""
    from mmdet.apis import inference_detector

    all_predictions: List[Dict[str, Any]] = []
    for img, img_path in items:
        try:
            result = inference_detector(model, str(img_path))
        except Exception as exc:
            logger.warning("MMYOLO inference failed for %s: %s", img_path, exc)
            continue

        preds = extract_predictions_from_result(
            result,
            image_id=img.id,
            num_classes=num_classes,
            conf_threshold=conf_threshold,
        )
        if preds:
            all_predictions.extend(preds)
    return all_predictions


def run_mmyolo_evaluation(
    celery_task,
    db,
    task,
    training_task,
    *,
    training_task_id: int,
    dataset_id: int,
    annotation_file_id: Optional[str],
    checkpoint: str,
    conf_threshold: float,
    iou_threshold: float,
    nms_iou_threshold: float,
    use_grid: bool,
    grid_size: int,
    grid_overlap: float,
    collection_id: Optional[int],
    ignored_classes: Optional[List[str]],
    image_size: Optional[int],
) -> Dict[str, Any]:
    """
    Run MMYOLO model evaluation using MMEngine inference.

    Produces the same result schema as Ultralytics YOLO evaluation so the
    existing frontend (Threshold Explorer, confusion matrix, etc.) works unchanged.
    """
    from datetime import datetime

    from app.evaluation_artifacts import write_evaluation_blobs
    from app.models import Dataset, Image
    from app.tasks.evaluation_helpers import accumulate_image_metrics, load_ground_truth_annotations
    from app.tasks.evaluation_tasks import (
        _resolve_eval_device,
        _resolve_evaluation_image_path,
        calculate_iou,
        update_parent_task_status,
    )

    if use_grid:
        logger.warning("MMYOLO evaluation does not support grid inference yet; using full-image mode")

    task_metadata = training_task.task_metadata or {}
    class_names = task_metadata.get("class_names") or []
    if not class_names:
        raise ValueError("No class names found in MMYOLO training task metadata")

    config_path = resolve_mmyolo_config_path(
        training_task.id,
        task_metadata,
        project_id=training_task.project_id,
    )
    if not config_path:
        raise ValueError("MMYOLO config file not found for training task")

    checkpoint_path = resolve_mmyolo_checkpoint(task_metadata, checkpoint)
    if not checkpoint_path:
        raise ValueError(f"MMYOLO checkpoint '{checkpoint}' not found")

    num_classes = len(class_names)
    eval_device = _resolve_eval_device()

    task.progress = 10
    task.task_metadata = {**task.task_metadata, "stage": "loading_model", "framework": "mmyolo"}
    db.commit()

    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise ValueError("Dataset not found")

    project_id = dataset.project_id
    if not project_id:
        raise ValueError("Dataset does not belong to a project")

    task.progress = 20
    task.task_metadata = {**task.task_metadata, "stage": "loading_annotations"}
    db.commit()

    has_ground_truth, ground_truth_annotations = load_ground_truth_annotations(
        db, annotation_file_id, class_names
    )

    images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
    if collection_id is not None:
        images_query = images_query.filter(Image.collection_id == collection_id)
    images = images_query.all()
    if not images:
        raise ValueError("No images found in dataset")

    image_id_to_filename = {img.id: img.file_name for img in images}

    ignored_class_ids = set()
    if ignored_classes:
        for class_name in ignored_classes:
            if class_name in class_names:
                ignored_class_ids.add(class_names.index(class_name))

    confusion_matrix = np.zeros((num_classes + 1, num_classes + 1), dtype=int)
    counters = {"true_positives": 0, "false_positives": 0, "false_negatives": 0}
    cm_samples: Dict[str, List[dict]] = {}
    all_predictions: List[Dict[str, Any]] = []
    predictions_count = 0

    valid_items = []
    for img in images:
        img_path = _resolve_evaluation_image_path(img, project_id, dataset_id, collection_id)
        if img_path is None:
            logger.warning("Image file not found for evaluation: %s", img.file_name)
            continue
        valid_items.append((img, img_path))

    if not valid_items:
        raise ValueError("No readable image files found for MMYOLO evaluation")

    task.progress = 30
    task.task_metadata = {**task.task_metadata, "stage": "running_inference"}
    db.commit()

    start_time = time.time()
    total_images = len(valid_items)

    flat_predictions = run_mmyolo_inference_subprocess(
        config_path=config_path,
        checkpoint_path=checkpoint_path,
        items=valid_items,
        num_classes=num_classes,
        conf_threshold=conf_threshold,
        device=eval_device,
        dji_repo_dir=task_metadata.get("dji_repo_dir"),
    )

    predictions_by_image: Dict[int, List[Dict[str, Any]]] = {}
    for pred in flat_predictions:
        predictions_by_image.setdefault(int(pred["image_id"]), []).append(pred)

    for idx, (img, _img_path) in enumerate(valid_items):
        image_predictions = predictions_by_image.get(img.id, [])
        predictions_count += len(image_predictions)
        if image_predictions:
            all_predictions.extend(image_predictions)

        accumulate_image_metrics(
            img=img,
            image_predictions=image_predictions,
            ground_truth_annotations=ground_truth_annotations,
            has_ground_truth=has_ground_truth,
            class_names=class_names,
            num_classes=num_classes,
            ignored_class_ids=ignored_class_ids,
            iou_threshold=iou_threshold,
            confusion_matrix=confusion_matrix,
            cm_samples=cm_samples,
            counters=counters,
            calculate_iou=calculate_iou,
        )

        if (idx + 1) % max(1, total_images // 10) == 0:
            task.progress = 30 + int((idx + 1) / total_images * 60)
            db.commit()

    inference_time_ms = (time.time() - start_time) * 1000

    all_ground_truth = []
    if has_ground_truth:
        for img_id, gt_list in ground_truth_annotations.items():
            fname = image_id_to_filename.get(img_id, "")
            for box in gt_list:
                cid = box["class_id"]
                if 0 <= cid < num_classes:
                    all_ground_truth.append(
                        {
                            "image_id": img_id,
                            "file_name": fname,
                            "class_id": cid,
                            "bbox": box["bbox"],
                            "class_name": class_names[cid],
                        }
                    )

    tp = counters["true_positives"]
    fp = counters["false_positives"]
    fn = counters["false_negatives"]
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1_score = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    avg_confidence = 0.0
    predictions_per_image = 0.0
    class_prediction_counts: Dict[str, int] = {}
    if all_predictions:
        avg_confidence = float(sum(float(p.get("conf", 0.0)) for p in all_predictions) / len(all_predictions))
        if total_images > 0:
            predictions_per_image = float(len(all_predictions) / total_images)
        for pred in all_predictions:
            class_id = int(pred.get("class_id", -1))
            if 0 <= class_id < len(class_names):
                name = class_names[class_id]
                class_prediction_counts[name] = class_prediction_counts.get(name, 0) + 1

    results = {
        "precision": float(precision),
        "recall": float(recall),
        "f1_score": float(f1_score),
        "map50": 0.0,
        "map50_95": 0.0,
        "confusion_matrix": confusion_matrix.tolist(),
        "class_names": class_names + ["background"],
        "project_id": project_id,
        "image_id_to_filename": {str(k): v for k, v in image_id_to_filename.items()},
        "predictions_count": predictions_count,
        "has_ground_truth": has_ground_truth,
        "avg_confidence": avg_confidence,
        "predictions_per_image": predictions_per_image,
        "class_prediction_counts": class_prediction_counts,
        "inference_time_ms": float(inference_time_ms),
        "images_processed": total_images,
        "training_task_id": training_task_id,
        "dataset_id": dataset_id,
        "collection_id": collection_id,
        "checkpoint": checkpoint,
        "conf_threshold": conf_threshold,
        "iou_threshold": iou_threshold,
        "nms_iou_threshold": nms_iou_threshold,
        "use_grid": False,
        "grid_size": None,
        "grid_overlap": None,
        "framework": "mmyolo",
        "model_checkpoint": checkpoint_path,
        "model_config": config_path,
    }

    if all_predictions or all_ground_truth or cm_samples:
        blobs_rel = write_evaluation_blobs(project_id, task.id, all_predictions, all_ground_truth, cm_samples)
        results["artifacts"] = {"blobs": blobs_rel, "format_version": 1}

    task.status = "completed"
    task.progress = 100
    task.completed_at = datetime.utcnow()
    task.task_metadata = {**task.task_metadata, "stage": "completed", "results": results}
    db.commit()

    parent_task_id = task.task_metadata.get("parent_task_id")
    if parent_task_id:
        update_parent_task_status(db, parent_task_id)

    logger.info(
        "MMYOLO evaluation completed: %s predictions on %s images (P=%.3f R=%.3f F1=%.3f)",
        predictions_count,
        total_images,
        precision,
        recall,
        f1_score,
    )
    return results
