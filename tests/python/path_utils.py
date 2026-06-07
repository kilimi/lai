"""Resolve backend and repo paths for host checkout vs worker containers (/app)."""
from __future__ import annotations

import os
from pathlib import Path


def resolve_backend_dir() -> Path:
    """Backend root: ``<repo>/backend`` on host, ``/app`` in worker-gpu/backend images."""
    override = os.environ.get("LAI_BACKEND_DIR", "").strip()
    if override:
        return Path(override)

    # tests/python/path_utils.py -> repo root is parents[2]
    repo_root = Path(__file__).resolve().parents[2]
    host_backend = repo_root / "backend"
    if (host_backend / "app").is_dir():
        return host_backend

    container_app = Path("/app")
    if (container_app / "app").is_dir():
        return container_app

    return host_backend


def resolve_python_tests_dir() -> Path:
    return Path(__file__).resolve().parent
