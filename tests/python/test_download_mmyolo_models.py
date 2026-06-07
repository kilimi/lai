"""Tests for MMYOLO download script helpers."""

from pathlib import Path

from scripts.download_mmyolo_models import (
    MINIMAL_ALIASES,
    checkpoint_cached,
    convert_yolov8_from_ultralytics,
    expected_checkpoint_path,
    resolve_spec,
)


def test_minimal_includes_yolov8_s():
    assert "yolov8_s" in MINIMAL_ALIASES


def test_resolve_spec_yolov8_alias():
    assert resolve_spec("yolov8_s") == ["yolov8_s"]


def test_expected_checkpoint_path_yolov8_s():
    path = expected_checkpoint_path("yolov8_s")
    assert path is not None
    assert path.name.startswith("yolov8_s_syncbn_fast_8xb16-500e_coco_")
    assert path.name.endswith(".pth")


def test_checkpoint_cached(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))
    pth = tmp_path / "yolov8_s_syncbn_fast_8xb16-500e_coco_20230117_180101-5aa5f0f1.pth"
    pth.write_bytes(b"ckpt")
    assert checkpoint_cached("yolov8_s") is True
    assert checkpoint_cached("rtmdet_s") is False


def test_convert_yolov8_fallback_missing_pt(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path / "mmyolo"))
    monkeypatch.setattr(
        "scripts.download_mmyolo_models.ULTRALYTICS_MODELS_DIR", tmp_path / "models"
    )
    monkeypatch.setattr("scripts.download_mmyolo_models.DEST_DIR", tmp_path / "mmyolo")
    monkeypatch.setattr(
        "scripts.download_mmyolo_models.ensure_ultralytics_pt", lambda _name: None
    )
    assert convert_yolov8_from_ultralytics("yolov8_s") is False


def test_convert_yolov8_fallback_writes_checkpoint(tmp_path, monkeypatch):
    mmyolo_dir = tmp_path / "mmyolo"
    models_dir = tmp_path / "models"
    mmyolo_dir.mkdir()
    models_dir.mkdir()
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(mmyolo_dir))
    monkeypatch.setattr(
        "scripts.download_mmyolo_models.ULTRALYTICS_MODELS_DIR", models_dir
    )
    monkeypatch.setattr("scripts.download_mmyolo_models.DEST_DIR", mmyolo_dir)

    pt_path = models_dir / "yolov8s.pt"
    pt_path.write_bytes(b"not-a-real-pt")

    def fake_convert(src: Path, dst: Path) -> Path:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"converted")
        return dst

    monkeypatch.setattr(
        "scripts.download_mmyolo_models.ensure_ultralytics_pt",
        lambda name: pt_path if name == "yolov8s.pt" else None,
    )

    def fake_subprocess_run(cmd, **kwargs):
        assert "-c" in cmd
        fake_convert(pt_path, expected_checkpoint_path("yolov8_s"))
        class Result:
            returncode = 0

        return Result()

    monkeypatch.setattr("scripts.download_mmyolo_models.subprocess.run", fake_subprocess_run)

    assert convert_yolov8_from_ultralytics("yolov8_s") is True
    dst = expected_checkpoint_path("yolov8_s")
    assert dst is not None
    assert dst.is_file()
