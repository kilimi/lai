"""COMPOSE_FILE helpers (Windows uses ``;`` between files, not ``:``)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

COMPOSE_MAIN = "docker-compose.yml"
COMPOSE_CODE_MOUNT = "docker-compose.code-mount.yml"


def is_windows() -> bool:
    return sys.platform == "win32" or os.name == "nt"


def compose_path_separator() -> str:
    return ";" if is_windows() else ":"


def compose_file_env_value(*, bind_code: bool = True) -> str:
    if not bind_code:
        return COMPOSE_MAIN
    sep = compose_path_separator()
    return f"{COMPOSE_CODE_MOUNT}{sep}{COMPOSE_MAIN}"


def split_compose_file_value(value: str) -> list[str]:
    """Split COMPOSE_FILE into individual compose file names."""
    raw = (value or COMPOSE_MAIN).strip().strip('"').strip("'")
    if not raw:
        return [COMPOSE_MAIN]
    for sep in (";", ":"):
        if sep in raw:
            parts = [p.strip() for p in raw.split(sep) if p.strip()]
            if parts:
                return parts
    return [raw]


def normalize_compose_file_value(value: str) -> str:
    """Use the path separator appropriate for the current OS."""
    parts = split_compose_file_value(value)
    if len(parts) <= 1:
        return parts[0] if parts else COMPOSE_MAIN
    return compose_path_separator().join(parts)


def compose_file_flag_args(bundle_root: Path, compose_file_value: str | None = None) -> list[str]:
    """Build ``docker compose -f <file> ...`` arguments."""
    value = compose_file_value or COMPOSE_MAIN
    args: list[str] = []
    for name in split_compose_file_value(value):
        args.extend(["-f", str(bundle_root / name)])
    return args


def fix_env_compose_file_for_platform(env_path: Path) -> bool:
    """
    On Windows, rewrite COMPOSE_FILE when it still uses ``:`` between compose files.
    Returns True if .env was updated.
    """
    if not env_path.is_file():
        return False
    lines = env_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    changed = False
    out: list[str] = []
    for line in lines:
        if not line.startswith("COMPOSE_FILE="):
            out.append(line)
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        normalized = normalize_compose_file_value(val)
        if normalized != val:
            changed = True
            out.append(f"{key}={normalized}")
        else:
            out.append(line)
    if changed:
        text = "\n".join(out)
        if text and not text.endswith("\n"):
            text += "\n"
        env_path.write_text(text, encoding="utf-8")
    return changed


def ensure_compose_env(bundle_root: Path) -> None:
    """Normalize COMPOSE_FILE in user .env for the current platform."""
    from lai.paths import resolve_env_file

    fix_env_compose_file_for_platform(resolve_env_file(bundle_root))
