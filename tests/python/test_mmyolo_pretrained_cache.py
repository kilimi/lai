"""Tests for offline MMYOLO pretrained checkpoint resolution."""

from pathlib import Path

from app.ml.mmyolo_catalog import (
    mmyolo_pretrained_requires_download,
    resolve_mmyolo_local_pretrained_checkpoint,
    resolve_mmyolo_pretrained_load_from,
)


def test_resolve_local_pretrained_flat_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))
    pth = tmp_path / "rtmdet_s_syncbn_fast_8xb32-300e_coco_20221230_182329-0a8c901a.pth"
    pth.write_bytes(b"ckpt")

    local = resolve_mmyolo_local_pretrained_checkpoint(
        "rtmdet_s_syncbn_fast_8xb32-300e_coco.py"
    )
    assert local == pth.resolve()
    assert resolve_mmyolo_pretrained_load_from("rtmdet_s") == str(pth.resolve())
    assert mmyolo_pretrained_requires_download("rtmdet_s") is False


def test_resolve_local_pretrained_nested_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))
    nested = tmp_path / "rtmdet"
    nested.mkdir()
    pth = nested / "rtmdet_s_syncbn_fast_8xb32-300e_coco_20221230_182329-0a8c901a.pth"
    pth.write_bytes(b"ckpt")

    local = resolve_mmyolo_local_pretrained_checkpoint("rtmdet_s")
    assert local == pth.resolve()


def test_requires_download_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))
    assert mmyolo_pretrained_requires_download("rtmdet_s") is True
    assert resolve_mmyolo_pretrained_load_from("rtmdet_s").startswith("https://")
