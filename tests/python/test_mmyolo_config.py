"""Tests for generated MMYOLO config content."""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_spec = importlib.util.spec_from_file_location(
    "mmyolo_config_test", BACKEND_DIR / "app/tasks/mmyolo_config.py"
)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]
MMYOLOConfigParams = _mod.MMYOLOConfigParams
build_mmyolo_config_content = _mod.build_mmyolo_config_content
resolve_mmyolo_base_config = _mod.resolve_mmyolo_base_config


def _sample_params(**overrides) -> MMYOLOConfigParams:
    base = dict(
        base_cfg="yolov8_s_syncbn_fast_8xb16-500e_coco.py",
        num_classes=2,
        class_names_py="('a', 'b')",
        epochs=30,
        batch_size=16,
        image_size=640,
        work_dir="/tmp/work",
        train_json_abs="/tmp/train.json",
        val_json_abs="/tmp/val.json",
        train_images_abs="/tmp/images/train",
        val_images_abs="/tmp/images/val",
        is_dji_mode=True,
        dji_use_widen_factor_025=False,
    )
    base.update(overrides)
    return MMYOLOConfigParams(**base)


def test_generated_config_avoids_albumentations_pipeline_switch():
    content = build_mmyolo_config_content(_sample_params())
    assert "type='mmdet.PipelineSwitchHook'" not in content
    assert "train_pipeline_stage2 = list(_pad_resize_pipeline)" in content
    assert "type='mmdet.Albu'" not in content
    assert "train_cfg = dict(" in content
    assert "max_epochs=max_epochs" in content
    assert "meta_keys=('img_id', 'img_path'" in content


def test_generated_config_uses_local_pretrained_when_cached(tmp_path, monkeypatch):
    pth = tmp_path / "yolov8_s_syncbn_fast_8xb16-500e_coco_20230117_180101-5aa5f0f1.pth"
    pth.write_bytes(b"ckpt")
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))

    content = build_mmyolo_config_content(
        _sample_params(
            base_cfg="yolov8_s_syncbn_fast_8xb16-500e_coco.py",
            is_dji_mode=False,
        )
    )
    assert f"load_from = '{pth.resolve()}'" in content
    assert "load_from = 'https://download.openmmlab.com" not in content


def test_generated_config_never_uses_remote_url_when_not_cached(tmp_path, monkeypatch):
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path / "empty"))
    content = build_mmyolo_config_content(
        _sample_params(
            base_cfg="yolov8_s_syncbn_fast_8xb16-500e_coco.py",
            is_dji_mode=False,
        )
    )
    assert "load_from = 'https://download.openmmlab.com" not in content
    assert "lai download-models" in content


def test_generated_config_dji_uses_local_pretrained_when_cached(tmp_path, monkeypatch):
    pth = tmp_path / "yolov8_s_syncbn_fast_8xb16-500e_coco_20230117_180101-5aa5f0f1.pth"
    pth.write_bytes(b"ckpt")
    monkeypatch.setenv("LAI_MMYOLO_MODELS_DIR", str(tmp_path))

    content = build_mmyolo_config_content(
        _sample_params(
            base_cfg=str(
                tmp_path / "configs" / "yolov8" / "yolov8_s_syncbn_fast_8xb16-500e_coco.py"
            ),
            is_dji_mode=True,
            dji_use_widen_factor_025=False,
        )
    )
    assert f"load_from = '{pth.resolve()}'" in content
    assert "https://download.openmmlab.com" not in content


def test_resolve_mmyolo_base_config_finds_absolute_path(tmp_path, monkeypatch):
    import app.tasks.mmyolo_config as mc

    root = tmp_path / "configs"
    (root / "rtmdet").mkdir(parents=True)
    cfg_file = root / "rtmdet" / "rtmdet_s_syncbn_fast_8xb32-300e_coco.py"
    cfg_file.write_text("# test config\n")
    monkeypatch.setattr(mc, "_mmyolo_config_search_roots", lambda: [root])

    resolved = mc.resolve_mmyolo_base_config("rtmdet_s")
    assert resolved == str(cfg_file.resolve())


def test_resolve_mmyolo_base_config_rtmdet_ins(tmp_path, monkeypatch):
    import app.tasks.mmyolo_config as mc

    root = tmp_path / "mim" / "configs"
    (root / "rtmdet").mkdir(parents=True)
    cfg_file = root / "rtmdet" / "rtmdet-ins_s_8xb32-300e_coco.py"
    cfg_file.write_text("# test config\n")
    monkeypatch.setattr(mc, "_mmyolo_config_search_roots", lambda: [root])

    resolved = mc.resolve_mmyolo_base_config("rtmdet-ins_s")
    assert resolved == str(cfg_file.resolve())


def test_normalize_config_stem_rtmdet_ins():
    from app.tasks.mmyolo_config import _normalize_config_stem

    assert _normalize_config_stem("rtmdet-ins_s") == "rtmdet-ins_s_8xb32-300e_coco"
    assert _normalize_config_stem("rtmdet-ins_s.py") == "rtmdet-ins_s_8xb32-300e_coco"


def test_generated_config_rtmdet_r_includes_mmrotate_and_coco_oriented_pipelines():
    content = build_mmyolo_config_content(
        _sample_params(
            arch="rtmdet-r",
            base_cfg="rtmdet-r_s_fast_1xb8-36e_dota.py",
            is_dji_mode=False,
        )
    )
    assert "'mmrotate'" in content
    assert "visualizer = dict(type='mmrotate.RotLocalVisualizer')" in content
    assert "type='mmdet.CocoDataset'" in content
    assert "ConvertMask2BoxType" in content
    assert "type='mmrotate.RotatedCocoMetric'" in content
    assert "type='mmdet.CocoMetric'" not in content


def test_generated_config_skips_pretrained_for_dji_widen_025():
    content = build_mmyolo_config_content(
        _sample_params(
            is_dji_mode=True,
            dji_use_widen_factor_025=True,
        )
    )
    assert "load_from = None" in content
    assert "widen_factor=0.25" in content
    assert "load_from = 'https://download.openmmlab.com" not in content


def test_resolve_dji_base_config_prefers_patched_repo(tmp_path):
    from app.tasks.mmyolo_dji import resolve_dji_base_config

    repo = tmp_path / "mmyolo"
    cfg = repo / "configs" / "yolov8" / "yolov8_s_syncbn_fast_8xb16-500e_coco.py"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("# patched dji config\n")
    resolved = resolve_dji_base_config(repo)
    assert resolved == str(cfg.resolve())


def test_dji_patch_is_applied_detects_diff(tmp_path):
    from app.tasks.mmyolo_dji import dji_patch_is_applied

    repo = tmp_path / "mmyolo"
    repo.mkdir()
    subprocess = __import__("subprocess")
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "t@test"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True, capture_output=True)
    (repo / "README.md").write_text("v0\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "v0"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "tag", "v0.6.0"], cwd=repo, check=True, capture_output=True)
    assert dji_patch_is_applied(repo) is False
    (repo / "README.md").write_text("patched\n")
    assert dji_patch_is_applied(repo) is True
