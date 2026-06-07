"""Tests for bundle root and env file resolution."""
from __future__ import annotations

from pathlib import Path

from lai.paths import config_dir, embedded_bundle_dir, get_bundle_root, resolve_env_file


def test_embedded_bundle_dir():
    assert embedded_bundle_dir().name == "bundle"
    assert embedded_bundle_dir().parent.name == "lai"


def test_resolve_env_file_developer_checkout(tmp_path: Path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text("include: []\n")
    (tmp_path / "backend").mkdir()
    monkeypatch.setattr("lai.paths._candidate_repo_root", lambda: tmp_path)
    assert resolve_env_file(tmp_path) == tmp_path / ".env"


def test_resolve_env_file_pypi_install(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("lai.paths._candidate_repo_root", lambda: None)
    monkeypatch.setattr("lai.registry.is_developer_checkout", lambda _r: False)
    assert resolve_env_file(tmp_path) == config_dir() / ".env"


def test_get_bundle_root_prefers_embedded(tmp_path: Path, monkeypatch):
    embedded = embedded_bundle_dir()
    if not (embedded / "docker-compose.yml").is_file():
        return  # bundle not built in this checkout
    monkeypatch.setattr("lai.paths._candidate_repo_root", lambda: None)
    assert get_bundle_root() == embedded.resolve()
