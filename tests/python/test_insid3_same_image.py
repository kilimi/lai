"""
INSID3 tests: mask alignment (host) and same-image inference (sam_service container).

Host unit tests use ``conftest.py`` to put ``backend/sam_service`` on PYTHONPATH.

The inference smoke test always delegates to ``sam_service`` when pytest runs on the
host (even if you started pytest outside Docker). Recreate ``sam_service`` after
updating compose so ``/tests`` is mounted:

  docker compose up -d sam_service --force-recreate

Run:

  pytest tests/python/test_insid3_mask_utils.py tests/python/test_insid3_same_image.py -v
  pytest tests/python/test_insid3_same_image.py -m insid3_smoke -v
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from insid3_mask_utils import normalize_reference_entry, polygon_area, polygon_to_binary_mask
from insid3_smoke.compose_probe import (
    container_script_path,
    exec_sam_service,
    exec_sam_service_script,
    is_inside_sam_service_container,
    require_sam_service_running,
    sam_service_has_tests_mount,
)
from sam_utils import encode_image_to_dataurl

_SAME_IMAGE_SCRIPT = Path(__file__).resolve().parent / "insid3_smoke" / "run_same_image.py"


def _synthetic_b64(width: int = 128, height: int = 128) -> str:
    arr = np.full((height, width, 3), 30, dtype=np.uint8)
    arr[30:100, 40:110] = np.array([200, 100, 50], dtype=np.uint8)
    return encode_image_to_dataurl(Image.fromarray(arr, mode="RGB").convert("RGBA"))


def test_same_image_reference_mask_aligns_with_image_b64():
    """Reference polygon rasterizes to a non-empty mask (no model required)."""
    width, height = 128, 128
    polygon = [[40, 30], [110, 30], [110, 100], [40, 100]]
    ref = {
        "imageB64": _synthetic_b64(width, height),
        "polygon": polygon,
        "width": width,
        "height": height,
    }
    _, mask = normalize_reference_entry(ref)
    assert int((mask > 0).sum()) > 500
    assert polygon_area(polygon) > 500
    assert polygon_to_binary_mask(polygon, width, height).sum() > 0


@pytest.mark.insid3_smoke
@pytest.mark.gpu
@pytest.mark.slow
def test_insid3_same_image_finds_region():
    """
    End-to-end: one reference mask on an image, segment the same image.

    Runs inside sam_service (GPU + DINOv3 weights). From the host, uses
    ``docker compose exec sam_service`` (or ``run`` with a tests bind-mount).
    """
    if is_inside_sam_service_container():
        from insid3_smoke.run_same_image import run_same_image_smoke

        run_same_image_smoke()
        return

    require_sam_service_running()

    timeout = int(os.environ.get("LAI_INSID3_SMOKE_TIMEOUT", "600"))
    if sam_service_has_tests_mount():
        proc = exec_sam_service(
            ["python", container_script_path("python/insid3_smoke/run_same_image.py")],
            timeout=timeout,
        )
    else:
        # Pipe script via stdin — works without /tests bind-mount on sam_service.
        proc = exec_sam_service_script(_SAME_IMAGE_SCRIPT, [], timeout=timeout)
    combined = f"{proc.stdout or ''}\n{proc.stderr or ''}".strip()
    if "SKIP:" in combined:
        pytest.skip(combined.split("SKIP:", 1)[1].strip().splitlines()[0])
    if proc.returncode != 0:
        pytest.fail(
            f"sam_service same-image INSID3 smoke failed (exit {proc.returncode}):\n{combined}"
        )
    assert "OK:" in (proc.stdout or ""), f"expected OK in stdout, got:\n{combined}"
