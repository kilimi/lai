"""Tests for YOLO ONNX mask coordinate unmapping (auto-annotate segmentation)."""
import numpy as np

from app.ml.inference.yolo_onnx_runner import (
    _letterbox,
    _mask_to_polygon,
    _unmap_mask_from_letterbox,
)


def _proto_mask_with_blob(proto_h: int, proto_w: int, cy: int, cx: int, radius: int = 8) -> np.ndarray:
    mask = np.zeros((proto_h, proto_w), dtype=np.float32)
    yy, xx = np.ogrid[:proto_h, :proto_w]
    mask[(yy - cy) ** 2 + (xx - cx) ** 2 <= radius**2] = 1.0
    return mask


def test_unmap_mask_from_letterbox_maps_proto_blob_to_original_center():
    """Proto masks must be upsampled, letterbox-cropped, then scaled to orig_shape."""
    img_h, img_w = 600, 800
    img_rgb = np.zeros((img_h, img_w, 3), dtype=np.uint8)
    _, orig_shape, _scale, resized_size = _letterbox(img_rgb, (640, 640))
    rw, rh = resized_size
    assert orig_shape == (img_h, img_w)

    proto_h = proto_w = 160
    # Blob center in letterbox pixels → divide by 4 for proto grid
    lb_cx, lb_cy = rw // 2, rh // 2
    proto_cx, proto_cy = lb_cx // 4, lb_cy // 4
    mask = _proto_mask_with_blob(proto_h, proto_w, proto_cy, proto_cx)

    unmapped = _unmap_mask_from_letterbox(
        mask, orig_shape, resized_size, letterbox_size=(640, 640)
    )
    assert unmapped.shape == (img_h, img_w)

    ys, xs = np.where(unmapped > 0.5)
    assert len(xs) > 0
    centroid_x = float(xs.mean())
    centroid_y = float(ys.mean())
    assert abs(centroid_x - img_w / 2) < 25
    assert abs(centroid_y - img_h / 2) < 25


def test_mask_to_polygon_returns_original_pixel_coords():
    img_h, img_w = 480, 640
    img_rgb = np.zeros((img_h, img_w, 3), dtype=np.uint8)
    _, orig_shape, _scale, resized_size = _letterbox(img_rgb, (640, 640))
    rw, rh = resized_size

    proto_h = proto_w = 160
    lb_cx, lb_cy = rw // 2, rh // 2
    mask = _proto_mask_with_blob(proto_h, proto_w, lb_cy // 4, lb_cx // 4, radius=10)

    polygon = _mask_to_polygon(mask, orig_shape, resized_size, letterbox_size=(640, 640))
    assert polygon is not None
    assert len(polygon) >= 6

    xs = polygon[0::2]
    ys = polygon[1::2]
    assert max(xs) <= img_w
    assert max(ys) <= img_h
    assert abs(float(np.mean(xs)) - img_w / 2) < 30
    assert abs(float(np.mean(ys)) - img_h / 2) < 30
