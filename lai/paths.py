from __future__ import annotations

import os
from pathlib import Path


def _package_dir() -> Path:
    return Path(__file__).resolve().parent


def embedded_bundle_dir() -> Path:
    """Compose-only tree shipped inside the PyPI wheel (`lai/bundle/`)."""
    return _package_dir() / "bundle"


def _candidate_repo_root() -> Path | None:
    """If lai/ lives at <repo>/lai/, return <repo> when docker-compose.yml is there."""
    pkg = _package_dir()
    guess = pkg.parent
    if (guess / "docker-compose.yml").is_file() and (guess / "backend").is_dir():
        return guess
    return None


def config_dir() -> Path:
    """Writable user config (`.env` for pull-only / PyPI installs)."""
    base = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if base:
        return Path(base) / "lai"
    return Path.home() / ".config" / "lai"


def bundle_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME", "").strip()
    if base:
        return Path(base) / "lai" / "app"
    return Path.home() / ".local" / "share" / "lai" / "app"


def is_embedded_bundle(bundle_root: Path) -> bool:
    embedded = embedded_bundle_dir()
    try:
        return embedded.is_dir() and bundle_root.resolve() == embedded.resolve()
    except OSError:
        return False


def resolve_env_file(bundle_root: Path) -> Path:
    """
    Path to the user's `.env`.

    Developer checkout: beside compose files in the repo.
    PyPI wheel / cached bundle: ``~/.config/lai/.env`` (writable across upgrades).
    """
    from lai.registry import is_developer_checkout

    if is_developer_checkout(bundle_root):
        return bundle_root / ".env"
    return config_dir() / ".env"


def get_bundle_root(*, force_download: bool = False) -> Path:
    """
    Directory that contains docker-compose.yml and dockers/.

    Priority:
    1. Developer checkout (repo root next to this package)
    2. Embedded bundle inside the PyPI wheel (`lai/bundle/`)
    3. Cached download under ~/.local/share/lai/app (legacy fallback)
    """
    local = _candidate_repo_root()
    if local is not None and not force_download:
        return local

    embedded = embedded_bundle_dir()
    if (embedded / "docker-compose.yml").is_file() and not force_download:
        return embedded

    return _ensure_cached_bundle(force=force_download)


def _ensure_cached_bundle(*, force: bool) -> Path:
    from lai.bundle import ensure_bundle

    return ensure_bundle(force=force)
