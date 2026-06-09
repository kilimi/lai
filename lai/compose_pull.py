"""Pull pre-built stack images from a container registry."""
from __future__ import annotations

import subprocess
from pathlib import Path

from lai.compose_build import _compose_base_cmd, _parse_env_file, uses_local_build
from lai.registry import CPU_IMAGE_KEYS, GPU_IMAGE_KEYS, gpu_tier_enabled


def _run(cmd: list[str], root: Path) -> int:
    print(f"+ cd {root} && {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=root).returncode


def compose_profiles(root: Path) -> list[str]:
    env = _parse_env_file(root)
    raw = (env.get("COMPOSE_PROFILES") or "").strip()
    if not raw:
        return ["gpu"] if gpu_tier_enabled(env) else []
    return [p.strip() for p in raw.replace(",", " ").split() if p.strip()]


def pull_services(root: Path) -> list[str] | None:
    """
    Service names to pass to ``docker compose pull``.

    None means pull all services in the active compose model (default).
    """
    if uses_local_build(root):
        return None
    env = _parse_env_file(root)
    if gpu_tier_enabled(env):
        return None
    # CPU tier: pull core app images; skip GPU-profile services.
    return ["backend", "worker-general", "celery-beat", "web"]


def pull_stack(root: Path, *, services: list[str] | None = None) -> int:
    """Pull images for the configured tier (registry tags in .env)."""
    if uses_local_build(root):
        print("Local build tags in .env — skipping registry pull.", flush=True)
        return 0

    from lai.registry import refresh_registry_tags

    refresh_registry_tags(root)

    cmd = _compose_base_cmd(root)
    for profile in compose_profiles(root):
        cmd.extend(["--profile", profile])
    cmd.append("pull")
    if services:
        cmd.extend(services)
    return _run(cmd, root)


def missing_registry_images(root: Path) -> list[str]:
    """Return configured registry image tags that are not present locally."""
    from lai.compose_build import _image_exists, image_tags
    from lai.registry import CPU_IMAGE_KEYS, GPU_IMAGE_KEYS, gpu_tier_enabled

    if uses_local_build(root):
        return []

    env = _parse_env_file(root)
    tags = image_tags(root)
    keys = list(CPU_IMAGE_KEYS)
    if gpu_tier_enabled(env):
        keys.extend(GPU_IMAGE_KEYS)

    missing: list[str] = []
    for key in keys:
        tag = tags.get(key, "")
        if tag and not _image_exists(tag):
            missing.append(tag)
    return missing
