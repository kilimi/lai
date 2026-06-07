"""Tests for LAI version resolution."""

from pathlib import Path

from app.lai_version import lai_version


def test_lai_version_from_env(monkeypatch):
    monkeypatch.setenv("LAI_VERSION", "2.3.4")
    lai_version.cache_clear()
    try:
        assert lai_version() == "2.3.4"
    finally:
        lai_version.cache_clear()


def test_lai_version_strips_v_prefix(monkeypatch):
    monkeypatch.setenv("LAI_VERSION", "v9.0.1")
    lai_version.cache_clear()
    try:
        assert lai_version() == "9.0.1"
    finally:
        lai_version.cache_clear()


def test_lai_version_reads_backend_version_file(monkeypatch):
    monkeypatch.delenv("LAI_VERSION", raising=False)
    lai_version.cache_clear()
    try:
        version = lai_version()
        version_file = Path(__file__).resolve().parents[2] / "backend" / "VERSION"
        assert version_file.is_file()
        assert version == version_file.read_text(encoding="utf-8").strip()
    finally:
        lai_version.cache_clear()
