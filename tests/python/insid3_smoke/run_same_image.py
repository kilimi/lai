#!/usr/bin/env python3
"""
INSID3 smoke: reference and target are the same synthetic image.

Intended to run inside sam_service (/app) where INSID3 and DINOv3 weights live.
Exit 0 on success, 1 on failure. Prints ``SKIP:`` and exits 0 when INSID3 is unavailable.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Host pytest may invoke via stdin; container uses /app on PYTHONPATH via cwd.
APP_DIR = Path("/app")
if APP_DIR.is_dir() and str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import numpy as np
from PIL import Image

from insid3_mask_utils import normalize_reference_entry, polygon_area
from insid3_runner import insid3_ready_for_api, segment_from_references
from sam_utils import encode_image_to_dataurl


def _synthetic_image(width: int = 256, height: int = 256) -> Image.Image:
    """RGB image with a high-contrast block (easy for in-context segmentation)."""
    arr = np.full((height, width, 3), 40, dtype=np.uint8)
    arr[70:190, 90:210] = np.array([230, 90, 50], dtype=np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _reference_polygon(width: int, height: int) -> list[list[float]]:
    return [
        [90.0, 70.0],
        [210.0, 70.0],
        [210.0, 190.0],
        [90.0, 190.0],
    ]


def run_same_image_smoke(*, image_size: int = 768, model_size: str = "base") -> None:
    if not insid3_ready_for_api(model_size):
        print("SKIP: INSID3 not ready (DINOv3 weights or INSID3 import missing)")
        return

    width, height = 256, 256
    pil = _synthetic_image(width, height)
    image_b64 = encode_image_to_dataurl(pil.convert("RGBA"))
    polygon = _reference_polygon(width, height)

    ref = {
        "imageB64": image_b64,
        "polygon": polygon,
        "width": width,
        "height": height,
        "imageName": "synthetic_same.png",
    }
    target = {
        "imageB64": image_b64,
        "width": width,
        "height": height,
    }

    # Sanity: reference mask must cover the painted block before calling the model.
    _, mask_np = normalize_reference_entry(ref)
    mask_area = int((mask_np > 0).sum())
    poly_area = polygon_area(polygon)
    assert mask_area > 1000, f"reference mask too small ({mask_area}px)"
    assert poly_area > 1000, f"reference polygon too small ({poly_area}px)"

    out = segment_from_references(
        [ref],
        target,
        image_size=image_size,
        model_size=model_size,
        min_area=0,
    )
    polys = out.get("polygons") or []
    if not polys:
        raise AssertionError("INSID3 returned no polygons for same-image reference/target")

    total_pts = sum(len(p) for p in polys)
    print(
        f"OK: INSID3 same-image smoke found {len(polys)} polygon(s), "
        f"{total_pts} vertices, maskBase64={'yes' if out.get('maskBase64') else 'no'}"
    )


def main() -> int:
    try:
        run_same_image_smoke()
        return 0
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
