"""Load dataset image bytes from /static/projects URLs (disk first, then HTTP)."""
from __future__ import annotations

import base64
import logging
import os
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

STATIC_PROJECTS_MARKER = "/static/projects/"
PROJECTS_ROOT = Path(os.environ.get("LAI_PROJECTS_DIR", "/app/projects"))
API_PUBLIC_BASE = os.environ.get("API_PUBLIC_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
API_INTERNAL_BASE = os.environ.get("API_INTERNAL_BASE_URL", "http://backend:8000").rstrip("/")


def static_url_to_local_path(url: str) -> Path | None:
    """Map ``/static/projects/...`` (or full URL containing it) to ``/app/projects/...``."""
    if not url:
        return None
    path = url.split("?", 1)[0]
    idx = path.find(STATIC_PROJECTS_MARKER)
    if idx < 0:
        return None
    rel = path[idx + len(STATIC_PROJECTS_MARKER) :].lstrip("/")
    rel = str(PurePosixPath(rel.replace("\\", "/")))
    return PROJECTS_ROOT / rel


def resolve_media_url(url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = API_PUBLIC_BASE
    return f"{base}{url}" if url.startswith("/") else f"{base}/{url}"


def _rewrite_localhost_to_internal(url: str) -> list[str]:
    """Candidate fetch URLs for Docker workers (backend service, host gateway)."""
    parsed = urlparse(url)
    candidates = [url]
    if parsed.hostname in ("localhost", "127.0.0.1"):
        internal = parsed._replace(netloc=urlparse(API_INTERNAL_BASE).netloc)
        candidates.append(urlunparse(internal))
        # Docker Desktop (Windows/macOS): host-mapped API port
        host_port = os.environ.get("LAI_HOST_API_PORT", "9999")
        host_gw = parsed._replace(netloc=f"host.docker.internal:{host_port}")
        candidates.append(urlunparse(host_gw))
    if parsed.path.startswith("/static/"):
        candidates.append(f"{API_INTERNAL_BASE}{parsed.path}")
    # de-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for item in candidates:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def fetch_image_bytes(url: str | None) -> bytes | None:
    """Read image bytes from mounted projects dir or HTTP."""
    if not url:
        return None

    local = static_url_to_local_path(url)
    if local is not None and local.is_file():
        try:
            return local.read_bytes()
        except OSError as exc:
            logger.warning("Failed to read local image %s: %s", local, exc)

    resolved = resolve_media_url(url)
    if not resolved:
        return None

    for fetch_url in _rewrite_localhost_to_internal(resolved):
        try:
            with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                resp = client.get(fetch_url)
                if resp.status_code == 200 and resp.content:
                    return resp.content
        except Exception as exc:
            logger.debug("HTTP image fetch failed for %s: %s", fetch_url, exc)
    return None


def fetch_image_b64(url: str | None) -> str | None:
    raw = fetch_image_bytes(url)
    if not raw:
        return None
    return base64.b64encode(raw).decode("ascii")
