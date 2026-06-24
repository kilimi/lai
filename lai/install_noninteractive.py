"""Non-interactive guided install (``lai install --yes``) without bash."""
from __future__ import annotations

import os
import sys
from pathlib import Path

from lai.docker_preflight import check_docker_stack
from lai.paths import resolve_env_file
from lai.registry import is_developer_checkout
from lai.wizard import (
    DINOV3_HF_MODEL_URL,
    SAM3_HF_MODEL_URL,
    _apply_setup,
    _default_dinov3_weights_dir,
    _default_sam3_checkpoint,
    _parse_dinov3_weights_path,
    _parse_sam3_checkpoint,
)

_DINOV3_BASE_CKPT = "dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth"


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off")


def _resolve_path(root: Path, raw: str | None, default: str) -> Path:
    text = (raw or default).strip()
    p = Path(text).expanduser()
    if not p.is_absolute():
        p = (root / p).resolve()
    else:
        p = p.resolve()
    return p


def run_install_noninteractive(
    root: Path,
    *,
    bind_code: bool | None = None,
) -> int:
    """Write .env and data dirs using the same defaults as ``install.sh --yes``."""
    errs = check_docker_stack(root)
    if errs:
        for err in errs:
            print(f"Error: {err}", file=sys.stderr)
        return 1

    dev = is_developer_checkout(root)
    if bind_code is None:
        if not dev:
            bind_host = False
        else:
            bind_host = _env_bool("LAI_BIND_CODE", default=True)
    else:
        bind_host = bind_code

    repo_root = os.environ.get("LAI_REPO_ROOT", "").strip()
    if repo_root:
        repo_path = Path(repo_root).expanduser().resolve()
    else:
        repo_path = root.resolve()

    if bind_host and not (repo_path / "backend").is_dir():
        print(
            f"Error: expected backend/ under {repo_path} (set LAI_REPO_ROOT).",
            file=sys.stderr,
        )
        return 1

    data_dir = os.environ.get("LAI_DATA_DIR", "").strip()
    if not data_dir:
        data_path = (Path.home() / "lai-data").resolve()
    else:
        data_path = _resolve_path(root, data_dir, str(Path.home() / "lai-data"))

    web_port = os.environ.get("WEB_PORT", "8089").strip()
    try:
        port_n = int(web_port)
        if not (1 <= port_n <= 65535):
            raise ValueError
    except ValueError:
        print(f"Error: invalid WEB_PORT: {web_port!r}", file=sys.stderr)
        return 1

    gpu_tier = _env_bool("LAI_GPU_TIER", default=True)
    lai_pt = os.environ.get("LAI_PRETRAINED_MODELS", "all").strip() or "all"
    lai_depth = os.environ.get("LAI_DEPTH_MODELS", "all").strip() or "all"

    sam3_dir_default = str(
        _resolve_path(root, None, str(root / "backend" / "sam_service" / "models"))
    )
    sam3_raw = os.environ.get("SAM3_MODELS_HOST_PATH", "").strip()
    if sam3_raw:
        sam3_host_dir = str(_resolve_path(root, sam3_raw, sam3_dir_default))
        sam3_file = os.environ.get("SAM3_CHECKPOINT_FILENAME", "sam3.pt").strip() or "sam3.pt"
    else:
        default_ckpt = _default_sam3_checkpoint(root, dev_checkout=dev)
        sam3_host_dir, sam3_file = _parse_sam3_checkpoint(default_ckpt)

    dinov3_default = _default_dinov3_weights_dir(root, dev_checkout=dev)
    dinov3_raw = os.environ.get("DINOV3_WEIGHTS_HOST_PATH", "").strip()
    if dinov3_raw:
        dinov3_resolved = _resolve_path(root, dinov3_raw, dinov3_default)
        if dinov3_resolved.suffix.lower() == ".pth":
            dinov3_resolved = dinov3_resolved.parent
        dinov3_host_dir = str(dinov3_resolved)
    else:
        dinov3_host_dir = _parse_dinov3_weights_path(dinov3_default)

    Path(sam3_host_dir).mkdir(parents=True, exist_ok=True)
    Path(dinov3_host_dir).mkdir(parents=True, exist_ok=True)

    _apply_setup(
        root,
        str(data_path),
        web_port,
        os.environ.get("VITE_API_URL", "SAME_ORIGIN").strip() or "SAME_ORIGIN",
        sam3_host_dir,
        sam3_file,
        dinov3_host_dir,
        lai_pretrained_models=lai_pt,
        lai_depth_models=lai_depth,
        bind_host_backend=bind_host,
        lai_repo_root=str(repo_path),
        gpu_tier=gpu_tier,
    )

    if dev and bind_host:
        from lai.wizard import _upsert_env_line

        env_file = resolve_env_file(root)
        _upsert_env_line(
            env_file,
            "MMCV_USE_PREBUILT",
            os.environ.get("MMCV_USE_PREBUILT", "1").strip() or "1",
        )
        _upsert_env_line(
            env_file,
            "MMCV_BUILD_JOBS",
            os.environ.get("MMCV_BUILD_JOBS", "2").strip() or "2",
        )

    for sub in ("postgres", "redis", "mongodb", "projects", "data", "backups", "runs"):
        (data_path / sub).mkdir(parents=True, exist_ok=True)

    env_file = resolve_env_file(root)
    print(f"Wrote {env_file}")
    print(f"  LAI_DATA_DIR={data_path}")
    print(f"  WEB_PORT={web_port}")
    print(f"  SAM3_MODELS_HOST_PATH={sam3_host_dir}")
    print(f"  DINOV3_WEIGHTS_HOST_PATH={dinov3_host_dir}")
    if dev and bind_host:
        print("  LAI_*_IMAGE=lai-*:local (use: lai dev)")

    sam3_full = Path(sam3_host_dir) / sam3_file
    if sam3_full.is_file():
        print(f"SAM 3: checkpoint found at {sam3_full}")
    else:
        print(f"SAM 3: not found at {sam3_full} (SAM 2 still works)")
        print(f"  Download from Hugging Face (license approval): {SAM3_HF_MODEL_URL}")

    dinov3_full = Path(dinov3_host_dir) / _DINOV3_BASE_CKPT
    if dinov3_full.is_file():
        print(f"DINOv3: default INSID3 checkpoint at {dinov3_full}")
    else:
        print(
            f"DINOv3: not found at {dinov3_full} — download from Hugging Face "
            f"(license approval): {DINOV3_HF_MODEL_URL}"
        )

    print("")
    print("Next steps:")
    print("  lai dev              # developer: ordered local build + start")
    print("  lai build && lai up  # or build then start")
    print(f"  http://localhost:{web_port}/")
    return 0
