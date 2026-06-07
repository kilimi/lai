"""Shared Ultralytics inference postprocessing (YOLO / RT-DETR)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.ml.predictions import from_ultralytics_result
from app.ml.schemas import PredictionRecord


def postprocess_ultralytics_results(
    results: List[Any],
    image_ids: List[int],
    conf_threshold: float = 0.25,
) -> List[PredictionRecord]:
    """Convert Ultralytics predict() results to PredictionRecords."""
    records: List[PredictionRecord] = []
    for image_id, result in zip(image_ids, results):
        records.extend(
            from_ultralytics_result(result, image_id=image_id, conf_threshold=conf_threshold)
        )
    return records


def prediction_records_to_api_payload(
    records: List[PredictionRecord],
    class_names: List[str],
) -> List[Dict[str, Any]]:
    """Format predictions for test-inference API responses."""
    out: List[Dict[str, Any]] = []
    for rec in records:
        name = class_names[rec.class_id] if 0 <= rec.class_id < len(class_names) else str(rec.class_id)
        item: Dict[str, Any] = {
            "class_id": rec.class_id,
            "class_name": name,
            "confidence": rec.conf,
            "bbox": rec.bbox_xywh,
        }
        if rec.bbox_xyxy is not None:
            item["bbox_xyxy"] = rec.bbox_xyxy
        if rec.segmentation:
            item["segmentation"] = rec.segmentation
        out.append(item)
    return out
