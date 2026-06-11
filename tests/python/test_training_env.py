#!/usr/bin/env python3
"""
Verify YOLO training environment inside worker-gpu.

From the host (stack must be up with healthy worker-gpu):

  pytest tests/python/test_training_env.py -v

Runs checks inside the container via docker compose exec when not already in worker-gpu.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from training_smoke.compose_probe import (
    exec_worker_gpu_script,
    is_inside_worker_container,
    require_worker_gpu_healthy,
)

pytestmark = pytest.mark.training_smoke

_CHECK_ENV_SCRIPT = Path(__file__).resolve().parent / "training_smoke" / "check_env.py"


def _exec_env_check(check: str) -> None:
    proc = exec_worker_gpu_script(
        _CHECK_ENV_SCRIPT,
        [check],
        timeout=int(os.environ.get("LAI_TRAINING_ENV_TIMEOUT", "120")),
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        pytest.fail(f"training env check {check!r} failed in worker-gpu:\n{msg}")


@pytest.fixture(scope="module", autouse=True)
def _require_gpu_worker():
    if is_inside_worker_container():
        return
    require_worker_gpu_healthy()


def test_imports():
    """Required packages are importable in the GPU worker."""
    if is_inside_worker_container():
        from training_smoke.check_env import check_imports

        check_imports()
        return
    _exec_env_check("imports")


def test_cuda():
    """CUDA is available and can run a small tensor op."""
    if is_inside_worker_container():
        from training_smoke.check_env import check_cuda

        check_cuda()
        return
    _exec_env_check("cuda")


def test_ultralytics():
    """Ultralytics is installed in the GPU worker."""
    if is_inside_worker_container():
        from training_smoke.check_env import check_ultralytics

        check_ultralytics()
        return
    _exec_env_check("ultralytics")


def main():
    print("=" * 60)
    print("YOLO Training Environment Test")
    print("=" * 60)

    results = []

    def _run(name, fn):
        try:
            fn()
            results.append((name, True))
        except Exception:
            results.append((name, False))

    _run("Imports", test_imports)
    _run("CUDA", test_cuda)
    _run("Ultralytics", test_ultralytics)

    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)

    all_passed = True
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{name:20} {status}")
        if not passed:
            all_passed = False

    print("=" * 60)

    if all_passed:
        print("\n✓ All tests passed! Environment is ready for YOLO training.")
        return 0
    print("\n⚠ Some tests failed. Check the errors above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
