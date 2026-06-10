"""YOLO11 ONNX inference for Auto-Annotate (detect / segment / classify)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import cv2
import numpy as np

PRETRAINED_MODELS_DIR = Path("/app/models")


@dataclass
class YoloDetection:
    class_id: int
    confidence: float
    bbox_xyxy: Tuple[float, float, float, float]
    segmentation: Optional[List[float]] = None


@dataclass
class YoloClassification:
    class_id: int
    confidence: float
    orig_shape: Tuple[int, int]


def _load_class_names(onnx_path: Path, fallback: Sequence[str]) -> List[str]:
    sidecar = Path(str(onnx_path) + ".classes.json")
    if sidecar.is_file():
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        names = data.get("class_names") or data.get("names")
        if names:
            return list(names)
    return list(fallback)


def _letterbox(
    img_rgb: np.ndarray, target_size: Tuple[int, int]
) -> Tuple[np.ndarray, Tuple[int, int], float, Tuple[int, int]]:
    h, w = img_rgb.shape[:2]
    tw, th = target_size
    scale = min(tw / w, th / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = cv2.resize(img_rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
    padded = np.zeros((th, tw, 3), dtype=np.uint8)
    padded[:nh, :nw] = resized
    tensor = padded.astype(np.float32) / 255.0
    tensor = np.transpose(tensor, (2, 0, 1))
    tensor = np.expand_dims(tensor, axis=0)
    return tensor, (h, w), scale, (nw, nh)


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - np.max(x, axis=-1, keepdims=True))
    return e / np.sum(e, axis=-1, keepdims=True)


def _nms_xyxy(
    boxes: np.ndarray,
    scores: np.ndarray,
    conf_threshold: float,
    iou_threshold: float,
) -> np.ndarray:
    if len(boxes) == 0:
        return np.array([], dtype=int)
    wh = np.column_stack([boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1]])
    keep = wh[:, 0] > 0
    boxes = boxes[keep]
    scores = scores[keep]
    if len(boxes) == 0:
        return np.array([], dtype=int)
    indices = cv2.dnn.NMSBoxes(
        np.column_stack([boxes[:, 0], boxes[:, 1], wh[keep, 0], wh[keep, 1]]).tolist(),
        scores.tolist(),
        conf_threshold,
        iou_threshold,
    )
    if len(indices) == 0:
        return np.array([], dtype=int)
    flat = indices.flatten()
    orig_idx = np.where(keep)[0]
    return orig_idx[flat]


def _unmap_mask_from_letterbox(
    mask: np.ndarray,
    orig_shape: Tuple[int, int],
    resized_size: Tuple[int, int],
    letterbox_size: Tuple[int, int],
) -> np.ndarray:
    """Map YOLO proto/letterbox mask logits to original image resolution."""
    oh, ow = orig_shape
    rw, rh = resized_size
    lh, lw = letterbox_size

    if mask.shape[0] != lh or mask.shape[1] != lw:
        mask_lb = cv2.resize(mask, (lw, lh), interpolation=cv2.INTER_LINEAR)
    else:
        mask_lb = mask

    mask_crop = mask_lb[:rh, :rw]
    if mask_crop.size == 0:
        return np.zeros((oh, ow), dtype=np.float32)

    return cv2.resize(mask_crop, (ow, oh), interpolation=cv2.INTER_LINEAR)


def _mask_to_polygon(
    mask: np.ndarray,
    orig_shape: Tuple[int, int],
    resized_size: Tuple[int, int],
    letterbox_size: Tuple[int, int],
) -> Optional[List[float]]:
    mask = _unmap_mask_from_letterbox(mask, orig_shape, resized_size, letterbox_size)
    if np.max(mask) < 0:
        mask = 1.0 / (1.0 + np.exp(-mask))
    binary = (mask > 0.5).astype(np.uint8) * 255
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < 10:
        return None
    approx = cv2.approxPolyDP(largest, 0.001 * cv2.arcLength(largest, True), True)
    if len(approx) < 3:
        return None
    return approx.reshape(-1, 2).flatten().tolist()


class YoloOnnxRunner:
    def __init__(
        self,
        onnx_path: Path,
        task_type: str,
        class_names: Sequence[str],
        *,
        imgsz: int = 640,
    ):
        import onnxruntime as ort

        self.onnx_path = Path(onnx_path)
        self.task_type = (task_type or "detect").lower()
        self.class_names = _load_class_names(self.onnx_path, class_names)
        self.imgsz = imgsz if self.task_type != "classify" else 224
        self.session = ort.InferenceSession(str(self.onnx_path))
        self.input_name = self.session.get_inputs()[0].name

    @classmethod
    def for_auto_annotate(
        cls,
        task_type: str,
        class_names: Sequence[str],
        models_dir: Path = PRETRAINED_MODELS_DIR,
    ) -> "YoloOnnxRunner":
        from app.foundation_models import auto_annotate_yolo_onnx_name

        onnx_name = auto_annotate_yolo_onnx_name(task_type)
        onnx_path = models_dir / onnx_name
        if not onnx_path.is_file():
            raise FileNotFoundError(
                f"Auto-Annotate ONNX model not found: {onnx_path}. "
                "Run: lai download-models (exports YOLO11m ONNX on worker-gpu)."
            )
        imgsz = 224 if task_type == "classify" else 640
        return cls(onnx_path, task_type, class_names, imgsz=imgsz)

    def predict_detect_or_segment(
        self,
        image_path: str | Path,
        *,
        conf_threshold: float = 0.25,
        iou_threshold: float = 0.45,
    ) -> Tuple[List[YoloDetection], Tuple[int, int]]:
        img_bgr = cv2.imread(str(image_path))
        if img_bgr is None:
            raise ValueError(f"Could not read image: {image_path}")
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        tensor, orig_shape, scale, resized_size = _letterbox(img_rgb, (self.imgsz, self.imgsz))
        outputs = self.session.run(None, {self.input_name: tensor})
        det_out = outputs[0]
        proto = outputs[1] if len(outputs) > 1 else None
        use_seg = self.task_type == "segment" and proto is not None

        if len(det_out.shape) == 3:
            det_out = det_out[0]
        if det_out.shape[0] < det_out.shape[1] and det_out.shape[0] <= 200:
            det_out = det_out.T

        num_features = det_out.shape[1]
        num_classes = len(self.class_names)
        mask_dim = 32 if use_seg else 0
        if num_features == 4 + num_classes + mask_dim:
            boxes_raw = det_out[:, :4]
            class_scores = det_out[:, 4 : 4 + num_classes]
            mask_coeffs = det_out[:, 4 + num_classes :] if use_seg else None
        elif num_features == 4 + num_classes:
            boxes_raw = det_out[:, :4]
            class_scores = det_out[:, 4:]
            mask_coeffs = None
        else:
            boxes_raw = det_out[:, :4]
            class_scores = det_out[:, 4 : 4 + min(num_classes, num_features - 4)]
            mask_coeffs = None

        if np.any(class_scores < 0) or np.any(class_scores > 1.5):
            class_scores = _softmax(class_scores)
        confidences = np.max(class_scores, axis=1)
        class_ids = np.argmax(class_scores, axis=1)
        valid = confidences >= conf_threshold
        if not np.any(valid):
            return [], orig_shape

        boxes_raw = boxes_raw[valid]
        confidences = confidences[valid]
        class_ids = class_ids[valid]
        if mask_coeffs is not None:
            mask_coeffs = mask_coeffs[valid]

        box_max = np.max(boxes_raw, axis=0)
        normalized = box_max[0] <= 1.0 and box_max[2] <= 1.0
        xyxy_like = np.mean((boxes_raw[:, 2] > boxes_raw[:, 0]) & (boxes_raw[:, 3] > boxes_raw[:, 1]))
        if xyxy_like > 0.5:
            x1, y1, x2, y2 = boxes_raw.T
            if normalized:
                s = float(self.imgsz)
                x1, y1, x2, y2 = x1 * s, y1 * s, x2 * s, y2 * s
        else:
            xc, yc, w, h = boxes_raw.T
            if normalized:
                s = float(self.imgsz)
                xc, yc, w, h = xc * s, yc * s, w * s, h * s
            x1 = xc - w / 2
            y1 = yc - h / 2
            x2 = xc + w / 2
            y2 = yc + h / 2

        rw, rh = resized_size
        x1 = np.clip(x1, 0, rw) / scale
        y1 = np.clip(y1, 0, rh) / scale
        x2 = np.clip(x2, 0, rw) / scale
        y2 = np.clip(y2, 0, rh) / scale
        x1 = np.clip(x1, 0, orig_shape[1])
        y1 = np.clip(y1, 0, orig_shape[0])
        x2 = np.clip(x2, 0, orig_shape[1])
        y2 = np.clip(y2, 0, orig_shape[0])
        boxes_xyxy = np.column_stack([x1, y1, x2, y2])

        keep = _nms_xyxy(boxes_xyxy, confidences, conf_threshold, iou_threshold)
        prototypes = None
        if use_seg and proto is not None:
            prototypes = proto[0] if len(proto.shape) == 4 else proto

        detections: List[YoloDetection] = []
        for idx in keep:
            seg = None
            if prototypes is not None and mask_coeffs is not None:
                coeffs = mask_coeffs[idx]
                mask = np.tensordot(coeffs, prototypes, axes=(0, 0))
                if np.max(mask) < 0:
                    mask = 1.0 / (1.0 + np.exp(-mask))
                seg = _mask_to_polygon(
                    mask,
                    orig_shape,
                    resized_size,
                    (self.imgsz, self.imgsz),
                )
            bx1, by1, bx2, by2 = boxes_xyxy[idx]
            detections.append(
                YoloDetection(
                    class_id=int(class_ids[idx]),
                    confidence=float(confidences[idx]),
                    bbox_xyxy=(float(bx1), float(by1), float(bx2), float(by2)),
                    segmentation=seg,
                )
            )
        return detections, orig_shape

    def predict_classify(self, image_path: str | Path) -> YoloClassification:
        img_bgr = cv2.imread(str(image_path))
        if img_bgr is None:
            raise ValueError(f"Could not read image: {image_path}")
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        orig_shape = img_rgb.shape[:2]
        tensor, _, _, _ = _letterbox(img_rgb, (self.imgsz, self.imgsz))
        outputs = self.session.run(None, {self.input_name: tensor})
        logits = outputs[0]
        if len(logits.shape) > 1:
            logits = logits[0]
        probs = _softmax(logits)
        class_id = int(np.argmax(probs))
        return YoloClassification(
            class_id=class_id,
            confidence=float(probs[class_id]),
            orig_shape=orig_shape,
        )
