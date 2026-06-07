"""LAI application version (PyPI package, UI footer, API)."""
from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

_DEFAULT_VERSION = "0.1.0"
_VERSION_RE = re.compile(r'^version\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


@lru_cache(maxsize=1)
def lai_version() -> str:
    """Resolve release version from LAI_VERSION env or pyproject.toml."""
    env = (os.environ.get("LAI_VERSION") or "").strip().lstrip("v")
    if env:
        return env

    candidates = (
        Path(__file__).resolve().parents[2] / "VERSION",
        Path(__file__).resolve().parents[3] / "pyproject.toml",
    )
    for path in candidates:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        if path.name == "VERSION":
            line = text.strip().splitlines()[0].strip().lstrip("v")
            if line:
                return line
        match = _VERSION_RE.search(text)
        if match:
            return match.group(1)
    return _DEFAULT_VERSION
