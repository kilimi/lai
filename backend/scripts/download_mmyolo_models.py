#!/usr/bin/env python3
"""
Download MMYOLO checkpoints/config assets for offline-first training.

Selection is controlled by LAI_MMYOLO_MODELS:
    - minimal (default): rtmdet_s, rtmdet-ins_s, rtmdet-r_s, yolov8_s
  - all: all supported arch/size combinations used by training UI
  - none: skip
  - comma list: e.g. rtmdet_s,rtmdet-ins_m,yolov8_s

Artifacts are downloaded via `python -m mim download <package> --config <name>`
into /app/models/mmyolo.

When OpenMMLab CDN / mim cannot fetch YOLOv8 weights, falls back to converting
Ultralytics YOLOv8 .pt checkpoints (from /app/models) using MMYOLO's
yolov8_to_mmyolo key mapping.

Notes:
    - rtmdet* and rtmdet-r* weights are in mmyolo package index.
    - rtmdet-ins* weights are in mmdet package index.
    - yolov8* weights are in mmyolo package index when OpenMMLab is reachable.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.ml.mmyolo_catalog import (
    MMYOLO_OFFICIAL_CONFIG_STEMS,
    mmyolo_pretrained_checkpoint,
    resolve_mmyolo_local_pretrained_checkpoint,
)
from app.ml.mmyolo_yolov8_convert import (
    YOLOV8_ALIAS_TO_ULTRALYTICS_PT,
    convert_yolov8_ultralytics_pt_to_mmyolo,
)
from app.ml.runtime_env import ULTRALYTICS_PYTHON, build_ultralytics_subprocess_env

DEST_DIR = Path("/app/models/mmyolo")
ULTRALYTICS_MODELS_DIR = Path("/app/models")
MMYOLO_PYTHON = os.environ.get("MMYOLO_PYTHON", "/opt/mmyolo-venv/bin/python")
if not Path(MMYOLO_PYTHON).exists():
    MMYOLO_PYTHON = sys.executable

# UI-facing aliases -> (mim package, official config id)
ALIAS_TO_TARGET = {
    "yolov8_n": ("mmyolo", "yolov8_n_syncbn_fast_8xb16-500e_coco"),
    "yolov8_s": ("mmyolo", "yolov8_s_syncbn_fast_8xb16-500e_coco"),
    "yolov8_m": ("mmyolo", "yolov8_m_syncbn_fast_8xb16-500e_coco"),
    "yolov8_l": ("mmyolo", "yolov8_l_syncbn_fast_8xb16-500e_coco"),
    "yolov8_x": ("mmyolo", "yolov8_x_syncbn_fast_8xb16-500e_coco"),

    "rtmdet_tiny": ("mmyolo", "rtmdet_tiny_syncbn_fast_8xb32-300e_coco"),
    "rtmdet_s": ("mmyolo", "rtmdet_s_syncbn_fast_8xb32-300e_coco"),
    "rtmdet_m": ("mmyolo", "rtmdet_m_syncbn_fast_8xb32-300e_coco"),
    "rtmdet_l": ("mmyolo", "rtmdet_l_syncbn_fast_8xb32-300e_coco"),
    "rtmdet_x": ("mmyolo", "rtmdet_x_syncbn_fast_8xb32-300e_coco"),

    # RTMDet-Ins lives in MMDetection model zoo.
    "rtmdet-ins_tiny": ("mmdet", "rtmdet-ins_tiny_8xb32-300e_coco"),
    "rtmdet-ins_s": ("mmdet", "rtmdet-ins_s_8xb32-300e_coco"),
    "rtmdet-ins_m": ("mmdet", "rtmdet-ins_m_8xb32-300e_coco"),
    "rtmdet-ins_l": ("mmdet", "rtmdet-ins_l_8xb32-300e_coco"),
    "rtmdet-ins_x": ("mmdet", "rtmdet-ins_x_8xb16-300e_coco"),

    "rtmdet-r_tiny": ("mmyolo", "rtmdet-r_tiny_fast_1xb8-36e_dota"),
    "rtmdet-r_s": ("mmyolo", "rtmdet-r_s_fast_1xb8-36e_dota"),
    "rtmdet-r_m": ("mmyolo", "rtmdet-r_m_syncbn_fast_2xb4-36e_dota"),
    "rtmdet-r_l": ("mmyolo", "rtmdet-r_l_syncbn_fast_2xb4-36e_dota"),
}

ALL_ALIASES = list(ALIAS_TO_TARGET.keys())
MINIMAL_ALIASES = ["rtmdet_s", "rtmdet-ins_s", "rtmdet-r_s", "yolov8_s"]


def resolve_spec(spec: str) -> list[str]:
    raw = (spec or "minimal").strip().lower()
    if raw == "none":
        return []
    if raw == "minimal":
        return MINIMAL_ALIASES
    if raw == "all":
        return ALL_ALIASES
    return [item.strip() for item in spec.split(",") if item.strip()]


def _mim_env() -> dict[str, str]:
    env = {**os.environ}
    env.pop("PYTHONPATH", None)
    return env


def expected_checkpoint_path(alias: str) -> Path | None:
    config_stem = MMYOLO_OFFICIAL_CONFIG_STEMS.get(alias) or ALIAS_TO_TARGET.get(
        alias, (None, None)
    )[1]
    if not config_stem:
        return None
    url = mmyolo_pretrained_checkpoint(config_stem)
    if not url:
        return None
    return DEST_DIR / url.rsplit("/", 1)[-1]


def checkpoint_cached(alias: str) -> bool:
    config_stem = MMYOLO_OFFICIAL_CONFIG_STEMS.get(alias) or ALIAS_TO_TARGET.get(
        alias, (None, None)
    )[1]
    if not config_stem:
        return False
    return resolve_mmyolo_local_pretrained_checkpoint(config_stem) is not None


def run_download(alias: str) -> bool:
    target = ALIAS_TO_TARGET.get(alias)
    if not target:
        print(f"  Skip {alias}: unknown alias", file=sys.stderr)
        return False

    if checkpoint_cached(alias):
        local = resolve_mmyolo_local_pretrained_checkpoint(
            MMYOLO_OFFICIAL_CONFIG_STEMS.get(alias, target[1])
        )
        print(f"  Already cached: {local}")
        return True

    package, config_name = target
    cmd = [
        MMYOLO_PYTHON,
        "-m",
        "mim",
        "download",
        package,
        "--config",
        config_name,
        "--dest",
        str(DEST_DIR),
    ]
    try:
        subprocess.run(cmd, check=True, env=_mim_env())
        if checkpoint_cached(alias):
            return True
        print(
            f"  mim finished but checkpoint not found for {alias}; trying fallback if available",
            file=sys.stderr,
        )
    except subprocess.CalledProcessError as exc:
        print(
            f"  mim failed for {alias} ({package}:{config_name}): exit {exc.returncode}",
            file=sys.stderr,
        )

    if alias in YOLOV8_ALIAS_TO_ULTRALYTICS_PT:
        return convert_yolov8_from_ultralytics(alias)
    return False


def ensure_ultralytics_pt(pt_name: str) -> Path | None:
    dst = ULTRALYTICS_MODELS_DIR / pt_name
    if dst.is_file():
        return dst

    ULTRALYTICS_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    py = ULTRALYTICS_PYTHON if Path(ULTRALYTICS_PYTHON).exists() else sys.executable
    code = (
        "import shutil, sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, '/app')\n"
        "from app.ml.runtime_env import ensure_ultralytics_sys_path\n"
        "ensure_ultralytics_sys_path()\n"
        "from ultralytics import YOLO\n"
        f"dst = Path({dst!r})\n"
        f"model = YOLO({pt_name!r})\n"
        "src = getattr(model, 'pt_path', None) or getattr(model, 'path', None)\n"
        "if src is None:\n"
        "    raise SystemExit('no pt path from ultralytics')\n"
        "src = Path(src)\n"
        "if src.is_file() and src.resolve() != dst.resolve():\n"
        "    shutil.copy2(src, dst)\n"
        "elif not dst.is_file():\n"
        "    raise SystemExit(f'weight not materialized at {dst}')\n"
        "print(dst)\n"
    )
    try:
        proc = subprocess.run(
            [py, "-c", code],
            check=True,
            capture_output=True,
            text=True,
            env=build_ultralytics_subprocess_env(),
        )
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or exc.stdout or "").strip()
        print(f"  Failed to download Ultralytics {pt_name}: {err}", file=sys.stderr)
        return None

    if dst.is_file():
        return dst
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if lines:
        candidate = Path(lines[-1])
        if candidate.is_file():
            return candidate
    return None


def convert_yolov8_from_ultralytics(alias: str) -> bool:
    pt_name = YOLOV8_ALIAS_TO_ULTRALYTICS_PT.get(alias)
    dst = expected_checkpoint_path(alias)
    if not pt_name or dst is None:
        print(f"  Skip YOLOv8 convert fallback for {alias}: missing mapping", file=sys.stderr)
        return False

    if dst.is_file():
        print(f"  YOLOv8 convert fallback already present: {dst}")
        return True

    pt_path = ensure_ultralytics_pt(pt_name)
    if pt_path is None:
        print(
            f"  YOLOv8 convert fallback for {alias} needs {pt_name} under {ULTRALYTICS_MODELS_DIR}. "
            "Run `lai download-models` (yolo=minimal includes yolov8s.pt) first.",
            file=sys.stderr,
        )
        return False

    print(
        f"  Converting Ultralytics {pt_path.name} → MMYOLO {dst.name} "
        "(yolov8_to_mmyolo mapping) ...",
        flush=True,
    )
    py = ULTRALYTICS_PYTHON if Path(ULTRALYTICS_PYTHON).exists() else sys.executable
    code = (
        "import sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, '/app')\n"
        "from app.ml.mmyolo_yolov8_convert import convert_yolov8_ultralytics_pt_to_mmyolo\n"
        f"convert_yolov8_ultralytics_pt_to_mmyolo(Path({str(pt_path)!r}), Path({str(dst)!r}))\n"
        f"print({str(dst)!r})\n"
    )
    try:
        subprocess.run(
            [py, "-c", code],
            check=True,
            env=build_ultralytics_subprocess_env(),
        )
    except subprocess.CalledProcessError as exc:
        print(
            f"  YOLOv8 convert fallback failed for {alias}: exit {exc.returncode}",
            file=sys.stderr,
        )
        return False

    if dst.is_file():
        print(f"  YOLOv8 convert fallback saved: {dst}")
        return True
    print(f"  YOLOv8 convert fallback did not write {dst}", file=sys.stderr)
    return False


def main() -> int:
    spec = os.environ.get("LAI_MMYOLO_MODELS", "minimal")
    aliases = resolve_spec(spec)

    DEST_DIR.mkdir(parents=True, exist_ok=True)

    if not aliases:
        print(f"LAI_MMYOLO_MODELS={spec!r} -> nothing to download")
        return 0

    probe = subprocess.run(
        [MMYOLO_PYTHON, "-m", "mim", "--help"], capture_output=True, env=_mim_env()
    )
    if probe.returncode != 0:
        print("mim is not available in this environment. Install openmim/mmyolo first.", file=sys.stderr)
        return 1

    print(f"LAI_MMYOLO_MODELS={spec!r} -> {len(aliases)} model alias(es) -> {DEST_DIR}")
    ok = 0
    for idx, alias in enumerate(aliases, 1):
        print(f"[{idx}/{len(aliases)}] Downloading {alias} ...", flush=True)
        if run_download(alias):
            ok += 1

    print(f"Done. Successful: {ok}/{len(aliases)}")
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
