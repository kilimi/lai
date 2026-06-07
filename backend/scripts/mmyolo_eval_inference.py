#!/usr/bin/env python3
"""MMYOLO batch inference for model evaluation (runs under MMYOLO_PYTHON)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List


def extract_predictions(result: Any, *, image_id: int, num_classes: int, conf_threshold: float) -> List[Dict[str, Any]]:
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Run MMYOLO inference for evaluation")
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--input-json", required=True, help="JSON list of {image_id, path}")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--num-classes", type=int, required=True)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default="0")
    args = parser.parse_args()

    input_path = Path(args.input_json)
    output_path = Path(args.output_json)
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 1

    with input_path.open("r", encoding="utf-8") as handle:
        items = json.load(handle)

    from mmdet.apis import init_detector, inference_detector

    mmdet_device = f"cuda:{args.device}" if args.device not in ("cpu", "") else "cpu"
    if mmdet_device.startswith("cuda:"):
        try:
            import torch

            if not torch.cuda.is_available():
                mmdet_device = "cpu"
        except Exception:
            mmdet_device = "cpu"

    model = init_detector(args.config, args.checkpoint, device=mmdet_device)

    all_predictions: List[Dict[str, Any]] = []
    for item in items:
        image_id = int(item["image_id"])
        img_path = str(item["path"])
        try:
            result = inference_detector(model, img_path)
        except Exception as exc:
            print(f"Inference failed for {img_path}: {exc}", file=sys.stderr)
            continue
        all_predictions.extend(
            extract_predictions(
                result,
                image_id=image_id,
                num_classes=args.num_classes,
                conf_threshold=args.conf,
            )
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(all_predictions, handle)

    print(f"Wrote {len(all_predictions)} predictions for {len(items)} images")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
