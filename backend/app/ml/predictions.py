"""Normalize framework-specific raw predictions to PredictionRecord."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.ml.schemas import PredictionRecord


def from_mmyolo_dict(raw: Dict[str, Any]) -> PredictionRecord:
    """Convert MMYOLO/mmdet eval dict to PredictionRecord."""
    bbox = raw.get("bbox") or [0.0, 0.0, 0.0, 0.0]
    bbox_xyxy = raw.get("bbox_xyxy")
    if bbox_xyxy is None and len(bbox) >= 4:
        x, y, w, h = (float(v) for v in bbox[:4])
        bbox_xyxy = [x, y, x + w, y + h]
    return PredictionRecord(
        image_id=int(raw["image_id"]),
        class_id=int(raw["class_id"]),
        conf=float(raw.get("conf", 0.0)),
        bbox_xywh=[float(v) for v in bbox[:4]],
        bbox_xyxy=[float(v) for v in bbox_xyxy[:4]] if bbox_xyxy else None,
        segmentation=raw.get("segmentation") or None,
    )


def from_ultralytics_result(
    result: Any,
    *,
    image_id: int,
    conf_threshold: float = 0.0,
) -> List[PredictionRecord]:
    """Convert an Ultralytics Results object to PredictionRecords."""
    records: List[PredictionRecord] = []
    if result is None:
        return records

    boxes = getattr(result, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return records

    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    cls_ids = boxes.cls.cpu().numpy()

    masks = None
    if hasattr(result, "masks") and result.masks is not None:
        masks = result.masks

    for i in range(len(xyxy)):
        conf = float(confs[i])
        if conf < conf_threshold:
            continue
        x1, y1, x2, y2 = (float(v) for v in xyxy[i][:4])
        class_id = int(cls_ids[i])
        seg: Optional[List[List[float]]] = None
        if masks is not None and i < len(masks):
            try:
                poly = masks.xy[i]
                if poly is not None and len(poly) > 0:
                    flat = [float(v) for pt in poly for v in pt[:2]]
                    seg = [flat] if len(flat) >= 6 else None
            except Exception:
                seg = None

        records.append(
            PredictionRecord(
                image_id=image_id,
                class_id=class_id,
                conf=conf,
                bbox_xywh=[x1, y1, x2 - x1, y2 - y1],
                bbox_xyxy=[x1, y1, x2, y2],
                segmentation=seg,
            )
        )
    return records


def to_eval_dicts(records: List[PredictionRecord]) -> List[Dict[str, Any]]:
    """Batch convert to evaluation pipeline dicts."""
    return [r.to_eval_dict() for r in records]
