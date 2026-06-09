"""Tests for install-gui wizard helpers."""
from __future__ import annotations

from pathlib import Path

from lai.wizard import (
    SAM3_CHECKPOINT_PLACEHOLDER,
    _default_sam3_checkpoint,
    _parse_sam3_checkpoint,
)


def test_parse_sam3_checkpoint_file_path(tmp_path: Path):
    ckpt = tmp_path / "weights" / "sam3.pt"
    ckpt.parent.mkdir()
    host_dir, name = _parse_sam3_checkpoint(str(ckpt))
    assert host_dir == str(ckpt.parent.resolve())
    assert name == "sam3.pt"


def test_parse_sam3_checkpoint_directory_defaults_filename(tmp_path: Path):
    host_dir, name = _parse_sam3_checkpoint(str(tmp_path))
    assert host_dir == str(tmp_path.resolve())
    assert name == "sam3.pt"


def test_default_sam3_checkpoint_pypi_uses_lai_data(monkeypatch, tmp_path: Path):
    monkeypatch.setattr("lai.wizard.Path.home", lambda: tmp_path)
    got = _default_sam3_checkpoint(tmp_path / "bundle", dev_checkout=False)
    assert got == str((tmp_path / "lai-data" / "sam3-models" / "sam3.pt").resolve())


def test_default_sam3_checkpoint_dev_uses_repo_models(tmp_path: Path):
    (tmp_path / "backend" / "sam_service" / "models").mkdir(parents=True)
    got = _default_sam3_checkpoint(tmp_path, dev_checkout=True)
    assert got.endswith("/backend/sam_service/models/sam3.pt")


def test_sam3_placeholder_constant():
    assert SAM3_CHECKPOINT_PLACEHOLDER == "/path_to_sam3_checkpoint"
