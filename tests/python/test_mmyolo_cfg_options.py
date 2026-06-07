"""Tests for MMYOLO mim CLI cfg-options assembly."""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_spec = importlib.util.spec_from_file_location(
    "mmyolo_config_opts_test", BACKEND_DIR / "app/tasks/mmyolo_config.py"
)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]
mmyolo_cfg_options_list = _mod.mmyolo_cfg_options_list


def test_cfg_options_are_separate_argv_tokens():
    opts = mmyolo_cfg_options_list(batch_size=8, epochs=100)
    assert len(opts) == 5
    assert opts[0] == "train_dataloader.batch_size=8"
    assert "train_cfg.max_epochs=100" in opts
    assert all("=" in o for o in opts)
