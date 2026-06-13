"""Unit tests for SAM mask → polygon helpers."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend" / "sam_service"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from utils import iter_instance_masks, polygons_from_instance_masks  # noqa: E402


def test_iter_instance_masks_splits_batch():
    masks = np.zeros((3, 1, 4, 4), dtype=np.float32)
    masks[0, 0, 1:3, 1:3] = 1.0
    masks[1, 0, 0:2, 0:2] = 1.0
    masks[2, 0, 2:4, 2:4] = 1.0
    instances = iter_instance_masks(masks)
    assert len(instances) == 3
    assert instances[0].shape == (4, 4)


def test_polygons_from_instance_masks_returns_multiple():
    masks = np.zeros((2, 1, 8, 8), dtype=np.float32)
    masks[0, 0, 2:6, 2:6] = 1.0
    masks[1, 0, 0:3, 0:3] = 1.0
    polys = polygons_from_instance_masks(masks, 8, 8)
    assert len(polys) >= 2
