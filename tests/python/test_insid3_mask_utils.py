"""Tests for INSID3 mask/polygon utilities."""
import numpy as np

from insid3_mask_utils import (
    mask_to_polygon_lists,
    mask_to_polygon_lists_with_stats,
    polygon_area,
    polygon_to_binary_mask,
    reference_entry_diagnostics,
)


def test_polygon_to_binary_mask_and_area():
    poly = [[10, 10], [50, 10], [50, 50], [10, 50]]
    mask = polygon_to_binary_mask(poly, 100, 100)
    assert mask.shape == (100, 100)
    assert mask[20, 20] == 255
    assert mask[0, 0] == 0
    area = polygon_area(poly)
    assert 1500 < area < 1700


def test_mask_to_polygon_lists_connected_components():
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[2:8, 2:8] = 255
    mask[12:18, 12:18] = 255
    polys = mask_to_polygon_lists(mask, 20, 20, min_area=0)
    assert len(polys) >= 2


def test_mask_to_polygon_lists_min_area():
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[2:4, 2:4] = 255
    polys, stats = mask_to_polygon_lists_with_stats(mask, 20, 20, min_area=100)
    assert len(polys) == 0
    assert stats["skippedByMinArea"] >= 1


def test_rasterize_scaled_when_declared_differs_from_image():
    from insid3_mask_utils import rasterize_reference_mask

    # Polygon in 1920 space, declared as 1024 — should scale to 1920 PIL
    poly = [[100.0, 100.0], [300.0, 100.0], [300.0, 300.0], [100.0, 300.0]]
    mask, w, h, _, strategy = rasterize_reference_mask(poly, 1024, 576, 1920, 1080)
    assert strategy == "scaled_to_pil"
    assert w == 1920 and h == 1080
    assert int((mask > 0).sum()) > 1000


def test_reference_entry_diagnostics_empty_mask_warning():
    diag = reference_entry_diagnostics(
        {
            "imageName": "a.jpg",
            "width": 100,
            "height": 100,
            "polygon": [[0, 0], [0, 0], [0, 0]],
        },
        0,
    )
    assert diag["warning"] == "empty_reference_mask"
    assert diag["maskPixels"] == 0
