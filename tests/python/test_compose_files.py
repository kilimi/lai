"""COMPOSE_FILE path separator (Windows vs Unix)."""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from lai.compose_files import (  # noqa: E402
    compose_file_env_value,
    fix_env_compose_file_for_platform,
    normalize_compose_file_value,
    split_compose_file_value,
)


def test_split_unix_style():
    assert split_compose_file_value("docker-compose.code-mount.yml:docker-compose.yml") == [
        "docker-compose.code-mount.yml",
        "docker-compose.yml",
    ]


def test_split_windows_style():
    assert split_compose_file_value("docker-compose.code-mount.yml;docker-compose.yml") == [
        "docker-compose.code-mount.yml",
        "docker-compose.yml",
    ]


def test_normalize_on_windows(monkeypatch):
    monkeypatch.setattr("lai.compose_files.is_windows", lambda: True)
    assert (
        normalize_compose_file_value("docker-compose.code-mount.yml:docker-compose.yml")
        == "docker-compose.code-mount.yml;docker-compose.yml"
    )


def test_compose_file_env_value_bind_code(monkeypatch):
    monkeypatch.setattr("lai.compose_files.is_windows", lambda: True)
    assert compose_file_env_value(bind_code=True) == (
        "docker-compose.code-mount.yml;docker-compose.yml"
    )
    assert compose_file_env_value(bind_code=False) == "docker-compose.yml"


def test_fix_env_compose_file_for_platform(tmp_path, monkeypatch):
    monkeypatch.setattr("lai.compose_files.is_windows", lambda: True)
    env = tmp_path / ".env"
    env.write_text(
        "COMPOSE_FILE=docker-compose.code-mount.yml:docker-compose.yml\nLAI_DATA_DIR=/data\n",
        encoding="utf-8",
    )
    assert fix_env_compose_file_for_platform(env) is True
    assert "COMPOSE_FILE=docker-compose.code-mount.yml;docker-compose.yml" in env.read_text(encoding="utf-8")
