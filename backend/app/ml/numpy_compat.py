"""Ensure NumPy 1.x for PyTorch 2.1 in the Celery worker (/opt/lai stack)."""
from __future__ import annotations

import logging
import os
import subprocess
import sys

logger = logging.getLogger(__name__)

_LAI_SITE = "/opt/lai/lib/python3.10/site-packages"
_NUMPY_SPEC = os.environ.get("LAI_NUMPY_SPEC", "numpy>=1.23.0,<2")
_VERIFIED = False


def _numpy_torch_ok() -> bool:
    try:
        import numpy as np
        import torch

        if int(np.__version__.split(".", 1)[0]) >= 2:
            return False
        torch.from_numpy(np.zeros((1, 3, 64, 64), dtype=np.float32))
        return True
    except Exception as exc:
        logger.warning("NumPy/PyTorch compatibility check failed: %s", exc)
        return False


def _reinstall_numpy() -> None:
    logger.warning("Reinstalling %s into %s for PyTorch compatibility", _NUMPY_SPEC, _LAI_SITE)
    subprocess.check_call(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--force-reinstall",
            _NUMPY_SPEC,
            "--target",
            _LAI_SITE,
        ],
        env={**os.environ, "PYTHONNOUSERSITE": "1"},
    )


def ensure_numpy_torch_compat() -> None:
    """
    PyTorch 2.1 (conda base in lai-celery) requires NumPy 1.x.

    Newer pip resolves can install NumPy 2.x into /opt/lai, breaking
    ``torch.from_numpy`` with ``RuntimeError: Numpy is not available``.
    """
    global _VERIFIED
    if _VERIFIED:
        return

    if _numpy_torch_ok():
        _VERIFIED = True
        return

    _reinstall_numpy()

    # Drop cached modules so the worker picks up the downgraded wheel.
    for name in list(sys.modules):
        if name == "numpy" or name.startswith("numpy."):
            del sys.modules[name]

    if not _numpy_torch_ok():
        raise RuntimeError(
            f"NumPy is incompatible with PyTorch after reinstall ({_NUMPY_SPEC}). "
            "Rebuild the GPU worker: docker compose build worker-gpu"
        )

    import numpy as np

    logger.info("NumPy %s verified compatible with PyTorch", np.__version__)
    _VERIFIED = True
