"""HTTP helpers with certifi + curl fallbacks (Windows SSL store issues)."""
from __future__ import annotations

import shutil
import ssl
import subprocess
import urllib.error
import urllib.request
from typing import Mapping


def ssl_context() -> ssl.SSLContext:
    """
    Prefer Mozilla CA bundle via certifi to avoid broken entries in the
    Windows certificate store (ssl.SSLError: ASN1 NOT_ENOUGH_DATA).
    """
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def fetch_bytes(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = 120.0,
) -> bytes:
    req = urllib.request.Request(url, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
            return resp.read()
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        TimeoutError,
        OSError,
        ssl.SSLError,
    ) as exc:
        data = _fetch_bytes_curl(url, headers=headers, timeout=timeout)
        if data is not None:
            return data
        raise RuntimeError(f"Failed to download {url}: {exc}") from exc


def _fetch_bytes_curl(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = 120.0,
) -> bytes | None:
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return None
    cmd = [curl, "-fsSL", "--max-time", str(int(max(1, timeout)))]
    for key, value in (headers or {}).items():
        cmd.extend(["-H", f"{key}: {value}"])
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except OSError:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return proc.stdout
