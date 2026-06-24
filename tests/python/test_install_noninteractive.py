"""Tests for lai install --yes (no bash)."""
from __future__ import annotations

from pathlib import Path

import pytest

from lai.install_noninteractive import _env_bool, _resolve_path, run_install_noninteractive


def test_env_bool():
    assert _env_bool("X", default=True) is True
    assert _env_bool("X", default=False) is False


def test_resolve_path_absolute(tmp_path: Path):
    got = _resolve_path(tmp_path, str(tmp_path / "data"), "ignored")
    assert got == (tmp_path / "data").resolve()


def test_resolve_path_relative_to_root(tmp_path: Path):
    got = _resolve_path(tmp_path, ".lai-data", "fallback")
    assert got == (tmp_path / ".lai-data").resolve()


def test_run_install_noninteractive_writes_env(tmp_path: Path, monkeypatch):
    (tmp_path / ".git").mkdir()
    (tmp_path / "backend").mkdir()
    (tmp_path / "docker-compose.yml").write_text("name: lai\n")
    (tmp_path / "docker-compose.code-mount.yml").write_text("name: lai\n")
    (tmp_path / "dockers" / "docker-compose.yml").write_text("name: lai\n")
    (tmp_path / "dockers" / "backend" / "docker-compose.yml").write_text("name: lai\nservices: {}\n")

    monkeypatch.setattr("lai.paths.resolve_env_file", lambda _r: tmp_path / ".env")
    monkeypatch.setattr("lai.docker_preflight.check_docker_stack", lambda _r: [])
    monkeypatch.setattr("lai.registry.is_developer_checkout", lambda _r: True)
    monkeypatch.setenv("LAI_DATA_DIR", str(tmp_path / "ldata"))
    monkeypatch.setenv("WEB_PORT", "8099")

    rc = run_install_noninteractive(tmp_path, bind_code=True)
    assert rc == 0
    env_text = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "LAI_DATA_DIR=" in env_text
    assert "LAI_BACKEND_IMAGE=lai-backend:local" in env_text
    assert (tmp_path / "ldata" / "postgres").is_dir()
