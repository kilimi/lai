"""Registry image tags and install-mode helpers for pull-only distribution."""
from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

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
_IMAGE_TAG_RE = re.compile(r":([^:@]+)(?:@|$)")


class RegistryTagResolutionError(RuntimeError):
    """Could not determine a Docker image tag that exists on the registry."""


def _ssl_context() -> ssl.SSLContext:
    from lai.http_fetch import ssl_context as _shared_ssl_context

    return _shared_ssl_context()


def _http_json(url: str, *, headers: dict[str, str] | None = None, timeout: float = 15.0) -> object | None:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        TimeoutError,
        json.JSONDecodeError,
        OSError,
        ssl.SSLError,
    ):
        return _http_json_curl(url, headers=headers, timeout=timeout)


def _http_json_curl(
    url: str, *, headers: dict[str, str] | None = None, timeout: float = 15.0
) -> object | None:
    """Fallback for environments where Python's SSL stack cannot reach Docker Hub."""
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return None
    cmd = [curl, "-fsSL", "--max-time", str(int(max(1, timeout)))]
    for key, value in (headers or {}).items():
        cmd.extend(["-H", f"{key}: {value}"])
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def _pick_best_tag(names: list[str]) -> str | None:
    """Highest x.y.z tag, else ``latest`` only when that name is present."""
    best_ver: tuple[int, int, int] | None = None
    best_name: str | None = None
    saw_latest = False
    for raw in names:
        name = str(raw or "").strip()
        if not name:
            continue
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
    if best_name:
        return best_name
    if saw_latest:
        return "latest"
    return None


def _tag_from_image_ref(image_ref: str) -> str | None:
    m = _IMAGE_TAG_RE.search((image_ref or "").strip())
    return m.group(1) if m else None


def _embedded_docker_release_file() -> Path | None:
    from lai.paths import embedded_bundle_dir

    path = embedded_bundle_dir() / "docker_release.json"
    return path if path.is_file() else None


def embedded_docker_fallback_tag() -> str | None:
    """
    Tag baked into the PyPI wheel at publish time (queried from Docker Hub in CI).

    Also reads a semver tag from bundled ``.env.example`` when ``docker_release.json``
    is missing.
    """
    release_file = _embedded_docker_release_file()
    if release_file is not None:
        try:
            data = json.loads(release_file.read_text(encoding="utf-8"))
            tag = str(data.get("docker_tag") or "").strip().lstrip("v")
            if tag and tag != "latest":
                return tag
        except (OSError, json.JSONDecodeError, TypeError):
            pass

    from lai.paths import embedded_bundle_dir

    example = embedded_bundle_dir() / ".env.example"
    if example.is_file():
        try:
            for line in example.read_text(encoding="utf-8").splitlines():
                if line.startswith("LAI_BACKEND_IMAGE="):
                    tag = _tag_from_image_ref(line.split("=", 1)[1])
                    if tag and tag != "latest" and _SEMVER_TAG.fullmatch(tag.lstrip("v")):
                        return tag.lstrip("v")
        except OSError:
            pass
    return None


def _tag_from_env_images(env: dict[str, str]) -> str | None:
    for key in ("LAI_RELEASE_VERSION",):
        raw = (env.get(key) or "").strip().lstrip("v")
        if raw and raw != "latest" and _SEMVER_TAG.fullmatch(raw):
            return raw
    for key in IMAGE_ENV_KEYS:
        tag = _tag_from_image_ref(env.get(key, ""))
        if tag and tag != "latest" and _SEMVER_TAG.fullmatch(tag.lstrip("v")):
            return tag.lstrip("v")
    return None


def _fetch_tags_registry_v2(org: str, repo: str, *, timeout: float = 15.0) -> list[str] | None:
    """List tags via ``registry-1.docker.io`` (works when hub.docker.com API fails)."""
    token_url = (
        "https://auth.docker.io/token"
        f"?service=registry.docker.io&scope=repository:{org}/{repo}:pull"
    )
    token_data = _http_json(token_url, timeout=timeout)
    if not isinstance(token_data, dict):
        return None
    token = str(token_data.get("token") or "").strip()
    if not token:
        return None
    tags_url = f"https://registry-1.docker.io/v2/{org}/{repo}/tags/list"
    data = _http_json(tags_url, headers={"Authorization": f"Bearer {token}"}, timeout=timeout)
    if not isinstance(data, dict):
        return None
    tags = data.get("tags")
    return [str(t) for t in tags] if isinstance(tags, list) else None


def _fetch_tags_hub_api(org: str, repo: str, *, timeout: float = 15.0) -> list[str] | None:
    names: list[str] = []
    url: str | None = f"https://hub.docker.com/v2/repositories/{org}/{repo}/tags?page_size=100"
    while url:
        data = _http_json(url, headers={"Accept": "application/json"}, timeout=timeout)
        if not isinstance(data, dict):
            return None
        for item in data.get("results") or []:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
                if name:
                    names.append(name)
        nxt = data.get("next")
        url = str(nxt) if nxt else None
    return names




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
    Highest semver tag on Docker Hub for ``org/repo``.

    Uses the Docker Registry v2 API first, then hub.docker.com. Returns ``latest``
    only when that tag is actually listed. Returns None when the repo cannot be read.
    """
    if _registry_host() != "docker.io":
        return None
    org = (org or "").strip()
    if not org:
        return None

    for fetcher in (_fetch_tags_registry_v2, _fetch_tags_hub_api):
        names = fetcher(org, repo, timeout=timeout)
        if not names:
            continue
        picked = _pick_best_tag(names)
        if picked:
            return picked
    return None


def resolve_release_version(env: dict[str, str] | None = None) -> str:
    """
    Docker image tag to pull (independent of the PyPI ``laivision`` package version).

    Order: pinned ``LAI_PIN_DOCKER_VERSION`` → live Docker Hub lookup → bundled /
    existing semver fallback. Never guesses ``latest`` when that tag is not on Hub.
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
        for fallback in (embedded_docker_fallback_tag(), _tag_from_env_images(env)):
            if fallback:
                print(
                    f"Docker Hub tag lookup failed; using {fallback!r}",
                    file=sys.stderr,
                )
                return fallback.lstrip("v")
        raise RegistryTagResolutionError(
            "Could not determine a Docker image tag from Docker Hub. "
            "Check your network, set LAI_PIN_DOCKER_VERSION=1 and LAI_RELEASE_VERSION=<tag> "
            "(e.g. 0.1.0), or upgrade laivision after images are published."
        )

    ver = (env.get("LAI_RELEASE_VERSION") or os.environ.get("LAI_RELEASE_VERSION", "")).strip()
    if ver:
        return ver.lstrip("v")
    fallback = embedded_docker_fallback_tag() or _tag_from_env_images(env)
    if fallback:
        return fallback.lstrip("v")
    raise RegistryTagResolutionError(
        "No Docker image tag configured. Run lai install or set LAI_RELEASE_VERSION."
    )


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
    if not _auto_docker_latest_enabled(env):
        return None
    try:
        ver = resolve_release_version(env)
    except RegistryTagResolutionError as exc:
        print(f"Warning: {exc}", file=sys.stderr)
        return None
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
    _upsert_env_line(env_file, "COMPOSE_PROJECT_NAME", "lai")
    _upsert_env_line(env_file, "LAI_GPU_TIER", "1" if gpu_tier else "0")
    if gpu_tier:
        _upsert_env_line(env_file, "COMPOSE_PROFILES", "gpu")
    else:
        _upsert_env_line(env_file, "COMPOSE_PROFILES", "")
