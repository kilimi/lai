"""DJI MMYOLO repository preparation (clone, patch, install)."""
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from app.ml.runtime_env import (
    MMYOLO_PYTHON,
    build_mmyolo_pip_install_env,
    build_mmyolo_subprocess_env,
)

logger = logging.getLogger(__name__)

DJI_PATCH_TAG = "tags/v0.6.0"
DJI_BRANCH = "drone-model-training"
DJI_CONFIG_REL = "configs/yolov8/yolov8_s_syncbn_fast_8xb16-500e_coco.py"


def dji_patch_is_applied(repo_dir: Path) -> bool:
    """True when the repo tree differs from unpatched mmyolo v0.6.0."""
    result = subprocess.run(
        ["git", "-C", str(repo_dir), "diff", "--quiet", DJI_PATCH_TAG],
        capture_output=True,
    )
    return result.returncode == 1


def verify_dji_patch_applied(repo_dir: Path) -> None:
    """Raise if the DJI AI Inside patch is not present in the repo."""
    if dji_patch_is_applied(repo_dir):
        return
    raise RuntimeError(
        "DJI AI Inside patch is not applied to the MMYOLO repo. "
        "Ensure you uploaded the official 0001-NEW-ai-inside-init.patch from the "
        "DJI developer portal (must match mmyolo v0.6.0). "
        f"Repo: {repo_dir}"
    )


def resolve_dji_base_config(repo_dir: Path, config_id: str = "yolov8_s_syncbn_fast_8xb16-500e_coco") -> str:
    """Prefer the patched repo config (DJI workflow) over /opt/mmyolo."""
    from app.tasks.mmyolo_config import _normalize_config_stem

    stem = _normalize_config_stem(config_id)
    candidates = [
        repo_dir / DJI_CONFIG_REL,
        repo_dir / "configs" / "yolov8" / f"{stem}.py",
        repo_dir / "configs" / f"{stem}.py",
    ]
    for path in candidates:
        if path.is_file():
            return str(path.resolve())
    raise FileNotFoundError(
        f"DJI MMYOLO config not found under {repo_dir} (expected {DJI_CONFIG_REL}). "
        "The AI Inside patch may be missing or incompatible."
    )


def prepare_dji_mmyolo_repo(patch_path: str) -> Path:
    """
    Prepare MMYOLO repo using DJI workflow:
    - clone open-mmlab/mmyolo from GitHub
    - checkout tags/v0.6.0 (DJI requirement)
    - create/switch branch drone-model-training
    - apply DJI patch (0001-NEW-ai-inside-init.patch)
    - install editable package
    """
    repo_root = Path(os.environ.get("MMYOLO_DJI_REPO_DIR", "/app/data/mmyolo_dji"))
    repo_dir = repo_root / "mmyolo"
    patch_file = Path(patch_path)

    if not patch_file.exists():
        raise FileNotFoundError(
            f"DJI patch file not found: {patch_file}\n"
            "Please ensure the patch file is available at the specified path."
        )

    repo_root.mkdir(parents=True, exist_ok=True)
    logger.info(f"Preparing DJI MMYolo repo at {repo_dir}")

    if not (repo_dir / ".git").exists():
        logger.info("Cloning mmyolo repository from GitHub...")
        try:
            result = subprocess.run(
                ["git", "clone", "https://github.com/open-mmlab/mmyolo.git", str(repo_dir)],
                check=True,
                capture_output=True,
                text=True,
            )
            logger.info(f"Clone successful: {result.stdout}")
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"Failed to clone mmyolo repository:\n"
                f"Command: {' '.join(e.cmd)}\n"
                f"Return code: {e.returncode}\n"
                f"Stdout: {e.stdout}\n"
                f"Stderr: {e.stderr}"
            )

    logger.info("Fetching git tags...")
    try:
        subprocess.run(
            ["git", "-C", str(repo_dir), "fetch", "--tags"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        logger.warning(f"Git fetch failed (non-fatal): {e.stderr}")

    logger.info("Checking out mmyolo v0.6.0 (DJI requirement)...")
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_dir), "checkout", "tags/v0.6.0"],
            check=True,
            capture_output=True,
            text=True,
        )
        logger.info(f"Checkout successful: {result.stdout}")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Failed to checkout mmyolo v0.6.0:\n"
            f"Stderr: {e.stderr}\n"
            "This version is required for DJI drone compatibility."
        )

    branch_exists = (
        subprocess.run(
            ["git", "-C", str(repo_dir), "show-ref", "--verify", "--quiet", "refs/heads/drone-model-training"],
            capture_output=True,
        ).returncode
        == 0
    )

    if branch_exists:
        logger.info("Switching to existing drone-model-training branch...")
        subprocess.run(
            ["git", "-C", str(repo_dir), "switch", "drone-model-training"],
            check=True,
            capture_output=True,
        )
    else:
        logger.info("Creating new drone-model-training branch...")
        subprocess.run(
            ["git", "-C", str(repo_dir), "switch", "-c", "drone-model-training"],
            check=True,
            capture_output=True,
        )

    logger.info(f"Checking if DJI patch can be applied: {patch_file}")
    check = subprocess.run(
        ["git", "-C", str(repo_dir), "apply", "--check", str(patch_file)],
        capture_output=True,
        text=True,
    )
    can_apply = check.returncode == 0

    if can_apply:
        logger.info("Applying DJI patch...")
        try:
            result = subprocess.run(
                ["git", "-C", str(repo_dir), "apply", str(patch_file)],
                check=True,
                capture_output=True,
                text=True,
            )
            logger.info(f"Patch applied successfully: {result.stdout}")
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"Failed to apply DJI patch:\n"
                f"Patch file: {patch_file}\n"
                f"Stderr: {e.stderr}"
            )
    elif dji_patch_is_applied(repo_dir):
        logger.info("DJI patch already applied on branch %s", DJI_BRANCH)
    else:
        raise RuntimeError(
            "DJI patch cannot be applied and the repo does not contain patch changes.\n"
            f"Patch file: {patch_file}\n"
            f"git apply --check stderr: {check.stderr.strip() or check.stdout.strip() or '(empty)'}\n"
            "Use the official DJI 0001-NEW-ai-inside-init.patch for mmyolo v0.6.0. "
            "If the repo was corrupted, delete "
            f"{repo_dir.parent} and retry training."
        )

    verify_dji_patch_applied(repo_dir)

    _install_mmyolo_for_dji(repo_dir)

    logger.info(f"DJI MMYolo repo prepared successfully at {repo_dir}")
    return repo_dir


def _verify_dji_repo_ready(repo_dir: Path, mmyolo_python: str) -> bool:
    """DJI training runs tools/train.py with repo on PYTHONPATH, not site-packages."""
    train_script = repo_dir / "tools" / "train.py"
    if not train_script.is_file():
        return False
    env = build_mmyolo_subprocess_env(dji_repo_dir=str(repo_dir))
    result = subprocess.run(
        [
            mmyolo_python,
            "-c",
            "import mmyolo; print('mmyolo', getattr(mmyolo, '__version__', 'unknown'))",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        logger.warning(
            "DJI repo import check failed (stdout=%r stderr=%r)",
            result.stdout,
            result.stderr,
        )
    return result.returncode == 0


def _install_mmyolo_for_dji(repo_dir: Path) -> None:
    mmyolo_python = os.environ.get("MMYOLO_PYTHON", MMYOLO_PYTHON)
    if not Path(mmyolo_python).is_file():
        raise RuntimeError(
            f"MMYOLO_PYTHON not found: {mmyolo_python}. "
            "Use the worker-gpu image with the mmyolo conda env."
        )

    install_env = build_mmyolo_pip_install_env()
    logger.info(
        "Installing mmyolo editable from %s using %s (worker is %s)",
        repo_dir,
        mmyolo_python,
        sys.executable,
    )

    pip_error: Optional[subprocess.CalledProcessError] = None
    for extra_args in (["--no-build-isolation"], []):
        cmd = [
            mmyolo_python,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            *extra_args,
            "-e",
            str(repo_dir),
        ]
        try:
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                env=install_env,
            )
            logger.info("MMYOLO editable install successful")
            return
        except subprocess.CalledProcessError as e:
            pip_error = e
            logger.warning(
                "pip install -e failed (%s): %s",
                " ".join(extra_args) or "default",
                (e.stderr or e.stdout or "")[:2000],
            )

    if _verify_dji_repo_ready(repo_dir, mmyolo_python):
        logger.info(
            "Editable install skipped; DJI training uses %s with PYTHONPATH=%s",
            repo_dir / "tools" / "train.py",
            repo_dir,
        )
        return

    err = pip_error
    raise RuntimeError(
        "Failed to install mmyolo into the MMYOLO conda env and repo is not importable.\n"
        f"MMYOLO_PYTHON: {mmyolo_python}\n"
        f"Do not use Celery worker python ({sys.executable}); it mixes /opt/lai site-packages.\n"
        f"Stderr: {err.stderr if err else ''}\n"
        f"Stdout: {err.stdout if err else ''}"
    )
