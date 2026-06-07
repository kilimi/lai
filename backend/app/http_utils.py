"""Build browser-reachable base URLs behind reverse proxies."""
from __future__ import annotations

from fastapi import Request


def public_request_base_url(request: Request) -> str:
    """
    Base URL for links returned to the browser.

    Nginx often sets ``Host: localhost`` (no port) via ``$host``; use
    ``X-Forwarded-Host`` / ``X-Forwarded-Port`` or the request URL port when present.
    """
    proto = (
        request.headers.get("x-forwarded-proto")
        or request.url.scheme
        or "http"
    ).split(",")[0].strip()

    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
        or "localhost"
    ).split(",")[0].strip()

    if ":" not in host:
        port = request.headers.get("x-forwarded-port", "").split(",")[0].strip()
        if port and port not in ("80", "443"):
            host = f"{host}:{port}"

    return f"{proto}://{host}".rstrip("/")
