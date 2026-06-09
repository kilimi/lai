"""Registry image tags and install-mode helpers for pull-only distribution."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from lai import __version__

# Default Docker Hub namespace when nothing else is configured (see registry_org()).
DEFAULT_DOCKERHUB_USER = "luluray"
GITHUB_REPO = os.environ.get("LAI_GITHUB_REPO", "lulu/lai")

IMAGE_ENV_KEYS: tuple[str, ...] = (
    "LAI_BACKEND_IMAGE",
    "LAI_WORKER_GPU_IMAGE",
    "LAI_WORKER_GENERAL_IMAGE",
    "LAI_ULTRALYTICS_IMAGE",
    "LAI_MMYOLO_IMAGE",
    "LAI_FRONTEND_IMAGE",
    "LAI_SAM_IMAGE",
)

_IMAGE_SHORT_NAMES: dict[str, str] = {
    "LAI_BACKEND_IMAGE": "lai-backend",
    "LAI_WORKER_GPU_IMAGE": "lai-worker-gpu",
    "LAI_WORKER_GENERAL_IMAGE": "lai-worker-general",
    "LAI_ULTRALYTICS_IMAGE": "lai-ultralytics",
    "LAI_MMYOLO_IMAGE": "lai-mmyolo",
    "LAI_FRONTEND_IMAGE": "lai-frontend",
    "LAI_SAM_IMAGE": "lai-sam",
}

# CPU stack images (always pulled).
CPU_IMAGE_KEYS: tuple[str, ...] = (
    "LAI_BACKEND_IMAGE",
    "LAI_WORKER_GENERAL_IMAGE",
    "LAI_FRONTEND_IMAGE",
)

# Extra images when GPU tier is enabled (worker-gpu embeds ultralytics + mmyolo stacks).
GPU_IMAGE_KEYS: tuple[str, ...] = (
    "LAI_WORKER_GPU_IMAGE",
    "LAI_SAM_IMAGE",
)

# Runtime pull checks — exclude build-only ML runtime tags.
PULL_IMAGE_KEYS: tuple[str, ...] = CPU_IMAGE_KEYS + GPU_IMAGE_KEYS


def _registry_host() -> str:
    return os.environ.get("LAI_REGISTRY", "docker.io").strip().rstrip("/")


def _org_from_image_ref(image_ref: str) -> str | None:
    """Extract registry namespace from ``docker.io/org/lai-backend:tag``."""
    ref = image_ref.strip().strip('"').strip("'")
    if not ref:
        return None
    if ref.startswith("docker.io/"):
        ref = ref[len("docker.io/") :]
    parts = ref.split("/")
    if len(parts) >= 2 and parts[0]:
        return parts[0]
    return None


def _embedded_registry_org() -> str | None:
    """Docker Hub org baked into the PyPI wheel at publish time (``lai/bundle/.env.example``)."""
    from lai.paths import embedded_bundle_dir

    example = embedded_bundle_dir() / ".env.example"
    if not example.is_file():
        return None
    try:
        text = example.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("LAI_BACKEND_IMAGE="):
            return _org_from_image_ref(line.split("=", 1)[1])
    return None


def registry_org() -> str:
    """Registry namespace / org for image tags."""
    if _registry_host() == "ghcr.io":
        return (
            os.environ.get("LAI_GHCR_ORG", "").strip()
            or _embedded_registry_org()
            or DEFAULT_DOCKERHUB_USER
        )
    explicit = os.environ.get("LAI_DOCKERHUB_USER", "").strip()
    if explicit:
        return explicit
    embedded = _embedded_registry_org()
    if embedded:
        return embedded
    return DEFAULT_DOCKERHUB_USER


def registry_prefix() -> str:
    org = registry_org()
    host = _registry_host()
    if host == "docker.io":
        return f"docker.io/{org}"
    return f"{host}/{org}"


def is_developer_checkout(bundle_root: Path) -> bool:
    """True when lai/ lives beside docker-compose.yml in a git/source tree."""
    from lai.paths import _candidate_repo_root

    root = _candidate_repo_root()
    return root is not None and root.resolve() == bundle_root.resolve()


_CANONICAL_HUB_REPO = "lai-backend"
_SEMVER_TAG = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def _env_bool(val: str | None, *, default: bool) -> bool:
    if val is None or not str(val).strip():
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def _auto_docker_latest_enabled(env: dict[str, str]) -> bool:
    if "LAI_AUTO_DOCKER_LATEST" in env:
        return _env_bool(env.get("LAI_AUTO_DOCKER_LATEST"), default=True)
    if "LAI_AUTO_DOCKER_LATEST" in os.environ:
        return _env_bool(os.environ.get("LAI_AUTO_DOCKER_LATEST"), default=True)
    return True


def _parse_env_file(path: Path) -> dict[str, str]:
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


def fetch_dockerhub_latest_tag(
    org: str,
    repo: str = _CANONICAL_HUB_REPO,
    *,
    timeout: float = 15.0,
) -> str | None:
    """
    Highest PEP-440-style x.y.z tag on Docker Hub for ``org/repo``.

    Falls back to the ``latest`` tag when no semver tags exist. Returns None if
    the registry cannot be reached or the repository is missing.
    """
    if _registry_host() != "docker.io":
        return None
    org = (org or "").strip()
    if not org:
        return None

    best_ver: tuple[int, int, int] | None = None
    best_name: str | None = None
    saw_latest = False
    url: str | None = (
        f"https://hub.docker.com/v2/repositories/{org}/{repo}/tags?page_size=100"
    )
    headers = {"Accept": "application/json"}

    try:
        while url:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("results") or []:
                name = str(item.get("name") or "")
                if name == "latest":
                    saw_latest = True
                    continue
                m = _SEMVER_TAG.fullmatch(name)
                if not m:
                    continue
                key = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
                if best_ver is None or key > best_ver:
                    best_ver = key
                    best_name = name.lstrip("v")
            url = data.get("next")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
        return None

    if best_name:
        return best_name
    if saw_latest:
        return "latest"
    return None


def resolve_release_version(env: dict[str, str] | None = None) -> str:
    """
    Docker image tag to pull.

    Order: pinned ``LAI_RELEASE_VERSION`` → Docker Hub newest x.y.z (or ``latest``)
    → ``LAI_RELEASE_VERSION`` / PyPI package version.
    """
    env = env or {}
    pinned = _env_bool(env.get("LAI_PIN_DOCKER_VERSION"), default=False) or _env_bool(
        os.environ.get("LAI_PIN_DOCKER_VERSION"), default=False
    )
    if pinned:
        ver = (env.get("LAI_RELEASE_VERSION") or os.environ.get("LAI_RELEASE_VERSION", "")).strip()
        if ver:
            return ver.lstrip("v")

    if _auto_docker_latest_enabled(env):
        remote = fetch_dockerhub_latest_tag(registry_org())
        if remote:
            return remote.lstrip("v")

    ver = (env.get("LAI_RELEASE_VERSION") or os.environ.get("LAI_RELEASE_VERSION", "")).strip()
    if ver:
        return ver.lstrip("v")
    return (__version__ or "0.0.0").lstrip("v")


def release_version() -> str:
    """Backward-compatible alias for :func:`resolve_release_version`."""
    return resolve_release_version()


def refresh_registry_tags(bundle_root: Path) -> str | None:
    """Refresh ``LAI_*_IMAGE`` tags in the user ``.env`` from Docker Hub (pull-only)."""
    from lai.compose_build import uses_local_build
    from lai.paths import resolve_env_file

    if uses_local_build(bundle_root) or is_developer_checkout(bundle_root):
        return None

    env_file = resolve_env_file(bundle_root)
    env = _parse_env_file(env_file)
    ver = resolve_release_version(env)
    old = (env.get("LAI_RELEASE_VERSION") or "").lstrip("v")
    if ver != old:
        print(f"Docker Hub image tag: {ver}" + (f" (was {old})" if old else ""), file=sys.stderr)

    write_registry_env(
        env_file,
        version=ver,
        gpu_tier=gpu_tier_enabled(env) if env else True,
        bind_code=False,
    )
    return ver


def registry_image_tag(key: str, version: str | None = None) -> str:
    short = _IMAGE_SHORT_NAMES[key]
    ver = (version or release_version()).lstrip("v")
    return f"{registry_prefix()}/{short}:{ver}"


def registry_image_tags(version: str | None = None) -> dict[str, str]:
    ver = version or release_version()
    return {key: registry_image_tag(key, ver) for key in IMAGE_ENV_KEYS}


def default_bundle_url(version: str | None = None) -> str:
    """GitHub Release asset URL for the slim compose-only distribution bundle (legacy fallback)."""
    override = os.environ.get("LAI_BUNDLE_URL", "").strip()
    if override:
        return override
    ver = (version or release_version()).lstrip("v")
    return f"https://github.com/{GITHUB_REPO}/releases/download/v{ver}/lai-dist-{ver}.tar.gz"


def gpu_tier_enabled(env: dict[str, str]) -> bool:
    raw = (env.get("LAI_GPU_TIER") or env.get("COMPOSE_PROFILES") or "").strip().lower()
    return raw in ("1", "true", "yes", "gpu") or "gpu" in raw.split(",")


def write_registry_env(
    env_file: Path,
    *,
    version: str | None = None,
    gpu_tier: bool = False,
    bind_code: bool = False,
) -> None:
    """Append registry image tags and release metadata to .env."""
    from lai.wizard import _upsert_env_line

    env_file.parent.mkdir(parents=True, exist_ok=True)
    existing = _parse_env_file(env_file)
    if version is not None:
        ver = version.lstrip("v")
    else:
        ver = resolve_release_version(existing)
    org = registry_org()
    tags = registry_image_tags(ver)
    for key, tag in tags.items():
        _upsert_env_line(env_file, key, tag)
    if _registry_host() == "docker.io":
        _upsert_env_line(env_file, "LAI_DOCKERHUB_USER", org)
    _upsert_env_line(env_file, "LAI_RELEASE_VERSION", ver.lstrip("v"))
    _upsert_env_line(env_file, "LAI_GPU_TIER", "1" if gpu_tier else "0")
    if gpu_tier:
        _upsert_env_line(env_file, "COMPOSE_PROFILES", "gpu")
    else:
        _upsert_env_line(env_file, "COMPOSE_PROFILES", "")
