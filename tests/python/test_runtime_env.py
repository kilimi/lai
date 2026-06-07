"""Tests for ML runtime env helpers."""
from __future__ import annotations

import sys


def test_ensure_ultralytics_sys_path_drops_lai_overlay():
    from app.ml.runtime_env import ensure_ultralytics_sys_path

    sys.path.insert(0, "/opt/lai/lib/python3.10/site-packages")
    ensure_ultralytics_sys_path()
    assert not any("/opt/lai/" in p for p in sys.path)


def test_build_ultralytics_subprocess_env_strips_pythonpath():
    import os

    from app.ml.runtime_env import (
        ULTRALYTICS_SITE,
        build_ultralytics_subprocess_env,
        conda_site_packages,
    )

    os.environ["PYTHONPATH"] = "/opt/lai/lib/python3.10/site-packages"
    env = build_ultralytics_subprocess_env(device="0")
    pythonpath = env.get("PYTHONPATH", "")
    parts = pythonpath.split(os.pathsep)
    assert ULTRALYTICS_SITE in parts
    assert parts.index(conda_site_packages()) < parts.index(ULTRALYTICS_SITE)
    assert "/opt/lai/" not in pythonpath.replace("\\", "/")
    assert env.get("CUDA_VISIBLE_DEVICES") == "0"
    assert env.get("PYTHONNOUSERSITE") == "1"


def test_build_mmyolo_subprocess_env_strips_pythonpath_and_sets_glibc():
    import os

    from app.ml.runtime_env import build_mmyolo_subprocess_env

    os.environ["PYTHONPATH"] = "/opt/lai/lib/python3.10/site-packages"
    env = build_mmyolo_subprocess_env(device="cpu")
    assert "PYTHONPATH" not in env
    assert env.get("GLIBC_TUNABLES") == "glibc.rtld.execstack=2"
    assert env.get("PYTHONNOUSERSITE") == "1"


def test_build_mmyolo_pip_install_env_strips_pythonpath():
    import os

    from app.ml.runtime_env import build_mmyolo_pip_install_env

    os.environ["PYTHONPATH"] = "/opt/lai/lib/python3.10/site-packages"
    env = build_mmyolo_pip_install_env()
    assert "PYTHONPATH" not in env
    assert env.get("PYTHONNOUSERSITE") == "1"
    assert env.get("MKL_THREADING_LAYER") == "GNU"


def test_build_mmyolo_subprocess_env_preserves_existing_glibc_tunables():
    import os

    from app.ml.runtime_env import build_mmyolo_subprocess_env

    os.environ["GLIBC_TUNABLES"] = "glibc.rtld.execstack=1"
    try:
        env = build_mmyolo_subprocess_env()
        assert env.get("GLIBC_TUNABLES") == "glibc.rtld.execstack=1"
    finally:
        os.environ.pop("GLIBC_TUNABLES", None)
