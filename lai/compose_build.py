"""Ordered docker compose builds for the LAI stack (split workers, ML runtimes)."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable

# Image env vars checked for local (:local / :dev) vs registry pulls.
IMAGE_ENV_KEYS = (
    "LAI_BACKEND_IMAGE",
    "LAI_WORKER_GPU_IMAGE",
    "LAI_WORKER_GENERAL_IMAGE",
    "LAI_ULTRALYTICS_IMAGE",
    "LAI_MMYOLO_IMAGE",
    "LAI_FRONTEND_IMAGE",
    "LAI_SAM_IMAGE",
)

DEFAULT_TAGS: dict[str, str] = {
    "LAI_BACKEND_IMAGE": "lai-backend:local",
    "LAI_WORKER_GPU_IMAGE": "lai-worker-gpu:local",
    "LAI_WORKER_GENERAL_IMAGE": "lai-worker-general:local",
    "LAI_ULTRALYTICS_IMAGE": "lai-ultralytics:local",
    "LAI_MMYOLO_IMAGE": "lai-mmyolo:local",
    "LAI_FRONTEND_IMAGE": "lai-frontend:local",
    "LAI_SAM_IMAGE": "lai-sam:local",
}

# Legacy alias (pre-split-worker installs); still read from .env for compatibility.
_LEGACY_CELERY_KEY = "LAI_CELERY_IMAGE"
_LEGACY_CELERY_DEFAULT = "lai-celery:local"

# Services built in dependency order (see dockers/backend/Dockerfile, Dockerfile.worker-gpu).
_BUILD_PROFILE_SERVICES = ("ultralytics_runtime", "mmyolo_runtime")
_BUILD_SERVICES = (
    "backend",
    "worker-gpu",
    "worker-general",
    "web",
    "sam_service",
)

# Compose service name → .env image key (skip build when tag already exists).
_RUNTIME_SERVICE_IMAGE_KEYS: dict[str, str] = {
    "ultralytics_runtime": "LAI_ULTRALYTICS_IMAGE",
    "mmyolo_runtime": "LAI_MMYOLO_IMAGE",
}
_APP_SERVICE_IMAGE_KEYS: dict[str, str] = {
    "backend": "LAI_BACKEND_IMAGE",
    "worker-gpu": "LAI_WORKER_GPU_IMAGE",
    "worker-general": "LAI_WORKER_GENERAL_IMAGE",
    "web": "LAI_FRONTEND_IMAGE",
    "sam_service": "LAI_SAM_IMAGE",
}


def _is_local_build_tag(tag: str) -> bool:
    """True when the tag indicates a local compose build (not a registry pull)."""
    tag = (tag or "").strip()
    if not tag:
        return True
    if tag.endswith(":local") or tag.endswith(":dev"):
        return True
    # No registry host → implicit local name (e.g. lai-backend:local).
    if "/" not in tag.split("@", 1)[0]:
        return True
    return False


def _parse_env_file(root: Path) -> dict[str, str]:
    from lai.paths import resolve_env_file

    path = resolve_env_file(root)
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, _, val = s.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def image_tags(root: Path) -> dict[str, str]:
    """Resolved image tags from .env with compose defaults."""
    env = _parse_env_file(root)
    tags = dict(DEFAULT_TAGS)
    legacy = env.get(_LEGACY_CELERY_KEY, "").strip()
    if legacy:
        tags[_LEGACY_CELERY_KEY] = legacy
        # Old .env files only set LAI_CELERY_IMAGE — treat as GPU worker image.
        if "LAI_WORKER_GPU_IMAGE" not in env:
            tags["LAI_WORKER_GPU_IMAGE"] = legacy
    for key in IMAGE_ENV_KEYS:
        if key in env and env[key].strip():
            tags[key] = env[key].strip()
    # Expose legacy key for tests / old tooling.
    tags.setdefault(_LEGACY_CELERY_KEY, tags.get("LAI_WORKER_GPU_IMAGE", _LEGACY_CELERY_DEFAULT))
    return tags


def uses_local_build(root: Path) -> bool:
    """True when any stack image is configured for local build."""
    env = _parse_env_file(root)
    tags = image_tags(root)
    keys = list(IMAGE_ENV_KEYS) + [_LEGACY_CELERY_KEY]
    configured = [k for k in keys if k in env and env[k].strip()]
    if configured:
        return any(_is_local_build_tag(tags.get(k, "")) for k in configured)
    return any(_is_local_build_tag(tags.get(k, "")) for k in keys)


def _image_exists(tag: str) -> bool:
    if not tag:
        return False
    proc = subprocess.run(
        ["docker", "image", "inspect", tag],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def missing_runtime_images(root: Path) -> list[str]:
    """Tags for local ML/runtime images that are not present on the host."""
    tags = image_tags(root)
    if not uses_local_build(root):
        return []
    missing: list[str] = []
    for key in (
        "LAI_ULTRALYTICS_IMAGE",
        "LAI_MMYOLO_IMAGE",
        "LAI_BACKEND_IMAGE",
        "LAI_WORKER_GPU_IMAGE",
        "LAI_WORKER_GENERAL_IMAGE",
        "LAI_FRONTEND_IMAGE",
        "LAI_SAM_IMAGE",
    ):
        tag = tags.get(key, "")
        if _is_local_build_tag(tag) and not _image_exists(tag):
            missing.append(tag)
    return missing


def should_build_stack(root: Path, *, force: bool = False) -> bool:
    """Whether lai up should run an ordered build before starting."""
    if force:
        return uses_local_build(root)
    return bool(missing_runtime_images(root))


def _services_needing_build(
    root: Path,
    service_names: Iterable[str],
    image_keys: dict[str, str],
    *,
    rebuild_all: bool,
) -> list[str]:
    """Return compose service names whose local image tag is not on the host."""
    if rebuild_all:
        return list(service_names)
    tags = image_tags(root)
    need: list[str] = []
    for service in service_names:
        key = image_keys.get(service)
        if not key:
            need.append(service)
            continue
        tag = tags.get(key, "")
        if _is_local_build_tag(tag) and not _image_exists(tag):
            need.append(service)
    return need


def _compose_base_cmd(root: Path) -> list[str]:
    from lai.compose_files import compose_file_flag_args, ensure_compose_env
    from lai.paths import resolve_env_file

    ensure_compose_env(root)
    env = _parse_env_file(root)
    compose_file = env.get("COMPOSE_FILE", "docker-compose.yml")
    cmd = ["docker", "compose", *compose_file_flag_args(root, compose_file)]
    env_path = resolve_env_file(root)
    if env_path.is_file():
        cmd.extend(["--env-file", str(env_path)])
    return cmd


def _run_build(
    root: Path,
    services: Iterable[str],
    *,
    no_cache: bool,
    profile_build: bool = False,
    step_label: str = "",
) -> int:
    names = list(services)
    if not names:
        return 0
    cmd = _compose_base_cmd(root)
    if profile_build:
        cmd.extend(["--profile", "build"])
    cmd.extend(["build", *names])
    if no_cache:
        cmd.append("--no-cache")
    if step_label:
        print(step_label, flush=True)
    print(f"+ cd {root} && {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=root).returncode


def build_stack(root: Path, *, no_cache: bool = False) -> int:
    """
    Build images in dependency order.

    ML runtime images (profile ``build``) must exist before ``backend`` copies MMYOLO.
    GPU/CPU workers are separate services (not ``celery_worker``).
    """
    if not uses_local_build(root):
        print("Using registry images from .env; skipping local build.", flush=True)
        return 0

    rebuild_all = no_cache
    profile_services = _services_needing_build(
        root, _BUILD_PROFILE_SERVICES, _RUNTIME_SERVICE_IMAGE_KEYS, rebuild_all=rebuild_all
    )
    app_services = _services_needing_build(
        root, _BUILD_SERVICES, _APP_SERVICE_IMAGE_KEYS, rebuild_all=rebuild_all
    )

    if not profile_services and not app_services:
        print("All local stack images are already present; skipping build.", flush=True)
        return 0

    total_steps = (1 if profile_services else 0) + len(app_services)
    step = 0

    if profile_services:
        step += 1
        rc = _run_build(
            root,
            profile_services,
            no_cache=no_cache,
            profile_build=True,
            step_label=(
                f"[{step}/{total_steps}] ML runtime images ({', '.join(profile_services)}) — "
                "first build can take 30–60+ minutes; then backend and workers build."
            ),
        )
        if rc != 0:
            return rc

    for service in app_services:
        step += 1
        rc = _run_build(
            root,
            (service,),
            no_cache=no_cache,
            step_label=f"[{step}/{total_steps}] Building {service}...",
        )
        if rc != 0:
            return rc
    return 0
