"""Mask/polygon helpers for INSID3 inference in sam_service."""
from __future__ import annotations

from typing import List, Sequence, Tuple, Union

import cv2
import numpy as np

from sam_utils import mask_to_polygons

PointLike = Union[Sequence[float], dict]


def _coerce_polygon_points(polygon: Sequence[PointLike]) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for p in polygon:
        if isinstance(p, dict):
            out.append((float(p.get("x", 0)), float(p.get("y", 0))))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            out.append((float(p[0]), float(p[1])))
    return out


def _points_to_nested(points: List[Tuple[float, float]]) -> List[List[float]]:
    return [[x, y] for x, y in points]


def _polygon_max_coord(points: List[Tuple[float, float]]) -> Tuple[float, float]:
    if not points:
        return 0.0, 0.0
    return max(p[0] for p in points), max(p[1] for p in points)


def _looks_normalized(points: List[Tuple[float, float]]) -> bool:
    if not points:
        return False
    max_x, max_y = _polygon_max_coord(points)
    return max_x <= 1.05 and max_y <= 1.05 and (max_x > 0 or max_y > 0)


def _polygon_bounds(polygon: Sequence[Sequence[float]]) -> tuple[float, float, float, float] | None:
    if not polygon:
        return None
    xs = [float(p[0]) for p in polygon]
    ys = [float(p[1]) for p in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _image_source_label(entry: dict) -> str:
    if entry.get("imageB64"):
        return "imageB64"
    if entry.get("imageUrl"):
        return "imageUrl"
    return "missing"


def log_reference_entry(ref: dict, index: int) -> None:
    """Debug log for one INSID3 reference (mask alignment, coords)."""
    name = ref.get("imageName") or ref.get("annotationId") or f"ref[{index}]"
    polygon = ref.get("polygon") or (ref.get("mask") or {}).get("polygon")
    w = int(ref.get("width") or ref.get("imageWidth") or 0)
    h = int(ref.get("height") or ref.get("imageHeight") or 0)
    bounds = _polygon_bounds(polygon) if polygon else None
    pts = len(polygon) if polygon else 0
    poly_area = polygon_area(polygon) if polygon else 0.0
    print(
        f"[INSID3] ref[{index}] {name}: source={_image_source_label(ref)} "
        f"declared={w}x{h} polygon_pts={pts} poly_area={poly_area:.0f}"
        + (f" bounds=({bounds[0]:.0f},{bounds[1]:.0f})-({bounds[2]:.0f},{bounds[3]:.0f})" if bounds else "")
    )


def log_target_entry(target: dict) -> None:
    w = int(target.get("width") or 0)
    h = int(target.get("height") or 0)
    print(
        f"[INSID3] target: source={_image_source_label(target)} declared={w}x{h}"
    )


def polygon_to_binary_mask(
    polygon: Sequence[PointLike],
    width: int,
    height: int,
) -> np.ndarray:
    """Rasterize a closed polygon to HxW uint8 {0, 255}."""
    mask = np.zeros((height, width), dtype=np.uint8)
    pts_xy = _coerce_polygon_points(polygon)
    if len(pts_xy) < 3:
        return mask
    pts = np.array([[int(round(x)), int(round(y))] for x, y in pts_xy], dtype=np.int32)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def rasterize_reference_mask(
    polygon: Sequence[PointLike],
    declared_w: int,
    declared_h: int,
    pil_w: int,
    pil_h: int,
) -> Tuple[np.ndarray, int, int, List[List[float]], str]:
    """
    Try several coordinate spaces until the reference mask has foreground pixels.

    Returns (mask, canvas_w, canvas_h, polygon_used, strategy).
    """
    base_pts = _coerce_polygon_points(polygon)
    if len(base_pts) < 3:
        return np.zeros((max(pil_h, 1), max(pil_w, 1)), dtype=np.uint8), pil_w, pil_h, [], "invalid"

    attempts: List[Tuple[int, int, List[List[float]], str]] = []
    base_nested = _points_to_nested(base_pts)

    if declared_w > 0 and declared_h > 0:
        attempts.append((declared_w, declared_h, base_nested, "declared"))
    if pil_w > 0 and pil_h > 0:
        attempts.append((pil_w, pil_h, base_nested, "pil_natural"))
    if (
        declared_w > 0
        and declared_h > 0
        and pil_w > 0
        and pil_h > 0
        and (pil_w != declared_w or pil_h != declared_h)
    ):
        sx = pil_w / declared_w
        sy = pil_h / declared_h
        scaled = [[x * sx, y * sy] for x, y in base_pts]
        attempts.append((pil_w, pil_h, scaled, "scaled_to_pil"))
    if _looks_normalized(base_pts):
        for tw, th, label in (
            (declared_w, declared_h, "normalized_declared"),
            (pil_w, pil_h, "normalized_pil"),
        ):
            if tw > 0 and th > 0:
                denorm = [[x * tw, y * th] for x, y in base_pts]
                attempts.append((tw, th, denorm, label))

    seen: set[str] = set()
    best_mask = None
    best_meta = (pil_w or declared_w, pil_h or declared_h, base_nested, "empty")
    for w, h, poly, strategy in attempts:
        key = f"{w}x{h}:{strategy}"
        if key in seen:
            continue
        seen.add(key)
        mask = polygon_to_binary_mask(poly, w, h)
        if int((mask > 0).sum()) > 0:
            return mask, w, h, poly, strategy
        best_mask = mask
        best_meta = (w, h, poly, strategy)
    if best_mask is not None:
        w, h, poly, strategy = best_meta
        return best_mask, w, h, poly, strategy
    return (
        np.zeros((max(pil_h, declared_h, 1), max(pil_w, declared_w, 1)), dtype=np.uint8),
        pil_w or declared_w,
        pil_h or declared_h,
        base_nested,
        "empty",
    )


def reference_entry_diagnostics(ref: dict, index: int = 0) -> dict:
    """Compact reference stats for API/GUI (no image decode when possible)."""
    name = ref.get("imageName") or ref.get("annotationId") or f"ref[{index}]"
    polygon = ref.get("polygon") or (ref.get("mask") or {}).get("polygon")
    declared_w = int(ref.get("width") or ref.get("imageWidth") or 0)
    declared_h = int(ref.get("height") or ref.get("imageHeight") or 0)
    w = declared_w
    h = declared_h
    bounds = _polygon_bounds(polygon) if polygon else None
    pts = len(polygon) if polygon else 0
    poly_area_val = polygon_area(polygon) if polygon else 0.0
    mask_pixels: int | None = None
    warning: str | None = None
    raster_strategy: str | None = None
    if polygon and declared_w > 0 and declared_h > 0:
        mask, w, h, _, raster_strategy = rasterize_reference_mask(
            polygon, declared_w, declared_h, declared_w, declared_h
        )
        mask_pixels = int((mask > 0).sum())
        if mask_pixels == 0:
            warning = "empty_reference_mask"
    elif not polygon:
        warning = "missing_polygon"
    elif declared_w <= 0 or declared_h <= 0:
        warning = "missing_dimensions"
    return {
        "index": index,
        "imageName": name,
        "width": w,
        "height": h,
        "polygonVertices": pts,
        "polygonArea": round(poly_area_val, 1),
        "maskPixels": mask_pixels,
        "rasterStrategy": raster_strategy,
        "bounds": list(bounds) if bounds else None,
        "warning": warning,
    }


def mask_to_polygon_lists(
    mask_np: np.ndarray,
    orig_w: int,
    orig_h: int,
    min_area: float = 0.0,
) -> List[List[List[int]]]:
    """Split binary mask into connected components and convert each to polygon(s)."""
    polys, _ = mask_to_polygon_lists_with_stats(mask_np, orig_w, orig_h, min_area=min_area)
    return polys


def mask_to_polygon_lists_with_stats(
    mask_np: np.ndarray,
    orig_w: int,
    orig_h: int,
    min_area: float = 0.0,
) -> tuple[List[List[List[int]]], dict]:
    """Like mask_to_polygon_lists but also returns post-processing stats for diagnostics."""
    if mask_np.ndim > 2:
        mask_np = np.squeeze(mask_np)
    binary = (mask_np > 0).astype(np.uint8)
    if binary.shape[0] != orig_h or binary.shape[1] != orig_w:
        from PIL import Image

        binary = np.array(
            Image.fromarray(binary * 255).resize((orig_w, orig_h), Image.NEAREST)
        )
        binary = (binary > 127).astype(np.uint8)

    num_labels, labels = cv2.connectedComponents(binary)
    polys_out: List[List[List[int]]] = []
    skipped_small = 0
    for label_id in range(1, num_labels):
        component = (labels == label_id).astype(np.uint8) * 255
        area = int(component.sum() // 255)
        if min_area > 0 and area < min_area:
            skipped_small += 1
            continue
        for poly in mask_to_polygons(component):
            if len(poly) >= 3:
                polys_out.append([[int(x), int(y)] for (x, y) in poly])
    raw_positive = int(binary.sum())
    print(
        f"[INSID3] mask_to_polygons: raw_positive_px={raw_positive} components={num_labels - 1} "
        f"polygons_out={len(polys_out)} skipped_by_min_area={skipped_small} "
        f"min_area={min_area} canvas={orig_w}x{orig_h}"
    )
    if raw_positive > 0 and len(polys_out) == 0:
        print("[INSID3] WARNING: model mask has pixels but no polygons exported (try min_area=0)")
    stats = {
        "rawPositivePixels": raw_positive,
        "components": int(num_labels - 1),
        "polygonsExported": len(polys_out),
        "skippedByMinArea": skipped_small,
        "minArea": float(min_area),
        "canvasWidth": int(orig_w),
        "canvasHeight": int(orig_h),
    }
    return polys_out, stats


def polygon_area(polygon: Sequence[PointLike]) -> float:
    """Shoelace area for a polygon in pixel coordinates."""
    pts = _coerce_polygon_points(polygon)
    if len(pts) < 3:
        return 0.0
    n = len(pts)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return abs(area) / 2.0


def load_target_image(ref: dict) -> tuple[np.ndarray, int, int]:
    """Load target RGB image; returns (img_np, width, height)."""
    import io

    import requests
    from PIL import Image

    from sam_utils import decode_base64_image

    if ref.get("imageB64"):
        pil = decode_base64_image(ref["imageB64"]).convert("RGB")
    elif ref.get("imageUrl"):
        r = requests.get(ref["imageUrl"], timeout=15)
        r.raise_for_status()
        pil = Image.open(io.BytesIO(r.content)).convert("RGB")
    else:
        raise ValueError("Target entry requires imageB64 or imageUrl")

    width = int(ref.get("width") or pil.width)
    height = int(ref.get("height") or pil.height)
    natural_w, natural_h = pil.size
    if natural_w > 0 and natural_h > 0 and (width <= 0 or height <= 0):
        width, height = natural_w, natural_h
    if pil.size != (width, height) and width > 0 and height > 0:
        print(f"[INSID3] target: resize PIL {pil.size[0]}x{pil.size[1]} -> {width}x{height}")
        pil = pil.resize((width, height), Image.BILINEAR)
    elif pil.size != (width, height):
        width, height = natural_w, natural_h
    print(f"[INSID3] target: loaded {width}x{height} from {_image_source_label(ref)}")
    return np.array(pil), width, height


def normalize_reference_entry(ref: dict) -> Tuple[np.ndarray, np.ndarray]:
    """
    Parse one reference dict into RGB image array (HxWx3) and binary mask (HxW).
    Accepts imageB64, polygon + width/height, or mask dimensions from image.
    """
    import io

    import requests
    from PIL import Image

    from sam_utils import decode_base64_image

    width = int(ref.get("width") or ref.get("imageWidth") or 0)
    height = int(ref.get("height") or ref.get("imageHeight") or 0)

    img_b64 = ref.get("imageB64")
    if img_b64:
        pil = decode_base64_image(img_b64).convert("RGB")
    elif ref.get("imageUrl"):
        r = requests.get(ref["imageUrl"], timeout=15)
        r.raise_for_status()
        pil = Image.open(io.BytesIO(r.content)).convert("RGB")
    else:
        raise ValueError("Reference entry requires imageB64 or imageUrl")

    natural_w, natural_h = pil.size
    img_np = np.array(pil)

    polygon = ref.get("polygon") or ref.get("mask", {}).get("polygon")
    if not polygon:
        raise ValueError("Reference entry requires polygon")

    declared_w = int(ref.get("width") or ref.get("imageWidth") or 0)
    declared_h = int(ref.get("height") or ref.get("imageHeight") or 0)
    mask, width, height, polygon_used, raster_strategy = rasterize_reference_mask(
        polygon,
        declared_w,
        declared_h,
        natural_w,
        natural_h,
    )
    mask_pixels = int((mask > 0).sum())
    bounds = _polygon_bounds(polygon_used)
    print(
        f"[INSID3] ref rasterized: imageName={ref.get('imageName')} "
        f"strategy={raster_strategy} mask_pixels={mask_pixels} canvas={width}x{height} "
        f"poly_area={polygon_area(polygon_used):.0f}"
        + (f" bounds=({bounds[0]:.0f},{bounds[1]:.0f})-({bounds[2]:.0f},{bounds[3]:.0f})" if bounds else "")
    )
    if mask_pixels == 0:
        print(
            "[INSID3] WARNING: reference mask is empty — polygon likely misaligned with image "
            "(check width/height vs annotation coordinate space)"
        )

    if img_np.shape[0] != height or img_np.shape[1] != width:
        pil = pil.resize((width, height), Image.BILINEAR)
        img_np = np.array(pil)

    return img_np, mask
