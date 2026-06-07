"""Tests for proxy-aware public base URL helper."""
from __future__ import annotations

import sys
from pathlib import Path

from starlette.requests import Request

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.http_utils import public_request_base_url  # noqa: E402


def _request(headers: list[tuple[bytes, bytes]], path: str = "/") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": headers,
        "scheme": "http",
        "server": ("backend", 8000),
        "client": ("127.0.0.1", 50000),
    }
    return Request(scope)


def test_public_base_url_uses_forwarded_host_with_port():
    req = _request(
        [
            (b"host", b"localhost"),
            (b"x-forwarded-host", b"localhost:8089"),
            (b"x-forwarded-proto", b"http"),
        ],
    )
    assert public_request_base_url(req) == "http://localhost:8089"


def test_public_base_url_uses_http_host_style_header():
    req = _request([(b"host", b"localhost:8089")])
    assert public_request_base_url(req) == "http://localhost:8089"
