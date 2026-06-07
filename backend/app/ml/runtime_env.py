"""Subprocess environment helpers for isolated ML runtimes."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Dict, Optional

ULTRALYTICS_PYTHON = os.environ.get("ULTRALYTICS_PYTHON", "/opt/conda/bin/python")
ULTRALYTICS_SITE = os.environ.get("ULTRALYTICS_SITE", "/opt/ultralytics-site")
MMYOLO_PYTHON = os.environ.get("MMYOLO_PYTHON", "/opt/conda/envs/mmyolo/bin/python")


def ultralytics_site_packages() -> Path:
    return Path(ULTRALYTICS_SITE)


def conda_site_packages(python: str | None = None) -> str:
    """Site-packages for the Ultralytics base conda env (PyTorch/CUDA)."""
    py = Path(python or ULTRALYTICS_PYTHON).resolve()
    lib = py.parent.parent / "lib"
    for candidate in sorted(lib.glob("python*/site-packages"), reverse=True):
        return str(candidate)
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    return str(lib / version / "site-packages")


def build_ultralytics_pythonpath(*extra: str) -> str:
    """
    Build PYTHONPATH for Ultralytics subprocess/in-process calls.

    Conda site-packages must precede ULTRALYTICS_SITE so pip --target wheels
    (e.g. torch cu130) do not shadow the base image PyTorch (cu121).
    """
    parts: list[str] = [conda_site_packages(), ULTRALYTICS_SITE, *extra]
    seen: set[str] = set()
    ordered: list[str] = []
    for part in parts:
        if part and part not in seen:
            seen.add(part)
            ordered.append(part)
    return os.pathsep.join(ordered)


def ensure_ultralytics_sys_path() -> None:
    """
    Prefer Ultralytics packages without shadowing base PyTorch with /opt/lai wheels.

    Used for short in-process calls (eval/export) on the merged celery worker image.
    """
    sys.path[:] = [p for p in sys.path if "/opt/lai/" not in p.replace("\\", "/")]
    conda_site = conda_site_packages()
    site = str(ultralytics_site_packages())
    for path in reversed((conda_site, site)):
        if path not in sys.path:
            sys.path.insert(0, path)


def build_ultralytics_subprocess_env(*, device: str = "") -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONNOUSERSITE"] = "1"
    env["ULTRALYTICS_PYTHON"] = ULTRALYTICS_PYTHON
    env["ULTRALYTICS_SITE"] = ULTRALYTICS_SITE
    env["PYTHONPATH"] = build_ultralytics_pythonpath()
    env.setdefault("MPLBACKEND", "Agg")
    if device not in ("", "cpu"):
        env["CUDA_VISIBLE_DEVICES"] = str(device)
    return env


def build_mmyolo_subprocess_env(
    *, device: str = "", dji_repo_dir: Optional[str] = None
) -> Dict[str, str]:
    """
    Environment for MMYOLO_PYTHON subprocesses.

    Strips host PYTHONPATH (backend/celery LAI or celery wheels shadow mmyolo's
    Python 3.8 stack). Sets GLIBC_TUNABLES so PyTorch 1.10 libtorch_cpu.so loads on
    glibc 2.39+ (python:3.10-slim backend) without execstack errors.
    """
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONNOUSERSITE"] = "1"
    env["MMYOLO_PYTHON"] = MMYOLO_PYTHON
    # Allow non-executable stack for legacy PyTorch 1.10 wheels (backend slim image).
    env.setdefault(
        "GLIBC_TUNABLES",
        os.environ.get("GLIBC_TUNABLES", "glibc.rtld.execstack=2"),
    )
    if dji_repo_dir and Path(dji_repo_dir).exists():
        env["PYTHONPATH"] = str(Path(dji_repo_dir))
    if device not in ("", "cpu"):
        env["CUDA_VISIBLE_DEVICES"] = str(device)
    return env


def build_mmyolo_pip_install_env() -> Dict[str, str]:
    """
    Environment for ``MMYOLO_PYTHON -m pip`` (e.g. DJI editable install).

    Must not inherit Celery worker PYTHONPATH (/opt/lai); pip would read broken
    worker site-packages (e.g. corrupt typing_extensions dist-info).
    """
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONNOUSERSITE"] = "1"
    env["MMYOLO_PYTHON"] = MMYOLO_PYTHON
    env.setdefault("MKL_SERVICE_FORCE_INTEL", "1")
    env["MKL_THREADING_LAYER"] = "GNU"
    env.setdefault("MKL_INTERFACE_LAYER", "GNU,LP64")
    env.setdefault(
        "GLIBC_TUNABLES",
        os.environ.get("GLIBC_TUNABLES", "glibc.rtld.execstack=2"),
    )
    return env
