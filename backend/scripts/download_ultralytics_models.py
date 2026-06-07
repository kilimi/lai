#!/usr/bin/env python3
"""
Download Ultralytics foundation models and export Auto-Annotate ONNX weights.

Auto-Annotate uses ONNX only: YOLO11 medium × detection / segmentation / classification
(see app.foundation_models.AUTO_ANNOTATE_YOLO_ONNX).

Training/export may still use .pt files from LAI_PRETRAINED_MODELS.

Requires Ultralytics (run on worker-gpu, not the slim backend API container):
  docker compose exec worker-gpu python scripts/download_ultralytics_models.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.foundation_models import (
    AUTO_ANNOTATE_YOLO_ONNX,
    AUTO_ANNOTATE_YOLO_PT,
    resolve_auto_annotate_onnx_download,
    resolve_ultralytics_pretrained_spec,
)

MODELS_DIR = Path("/app/models")


def _bootstrap_ultralytics_runtime() -> None:
    """Use conda + /opt/ultralytics-site (onnx lives there, not in /opt/lai)."""
    from app.ml.runtime_env import ensure_ultralytics_sys_path
    from app.ml.ultralytics_compat import patch_ultralytics_lazy_exports

    ensure_ultralytics_sys_path()
    patch_ultralytics_lazy_exports()


def _onnx_export_deps_available() -> bool:
    try:
        import onnx  # noqa: F401
        return True
    except ImportError:
        return False


def _should_export_auto_annotate_onnx(spec: str) -> bool:
    """Skip ONNX when user requested a single training .pt (e.g. yolov8n.pt)."""
    if os.environ.get("LAI_SKIP_AUTO_ANNOTATE_ONNX", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return False
    sl = (spec or "").strip().lower()
    if sl in ("none", "on_demand", "runtime", "download_on_request"):
        return False
    # One explicit checkpoint name → training download only.
    if sl.endswith(".pt") and "," not in spec:
        return False
    return True


def _export_pt_to_onnx(pt_path: Path, *, imgsz: int) -> Path:
    _bootstrap_ultralytics_runtime()
    if not _onnx_export_deps_available():
        raise ImportError(
            "onnx is not importable (expected under /opt/ultralytics-site). "
            "Rebuild worker-gpu or run export with ULTRALYTICS_PYTHON."
        )

    from ultralytics import YOLO

    model = YOLO(str(pt_path))
    # simplify=False avoids onnxslim when only onnx is present in ultralytics-site.
    exported = model.export(format="onnx", imgsz=imgsz, simplify=False)
    exported_path = Path(exported)
    if not exported_path.is_file():
        raise FileNotFoundError(f"ONNX export did not produce a file for {pt_path}")
    onnx_path = pt_path.with_suffix(".onnx")
    if exported_path.resolve() != onnx_path.resolve():
        shutil.copy2(exported_path, onnx_path)
    names = getattr(model, "names", None)
    if names:
        sidecar = Path(str(onnx_path) + ".classes.json")
        if isinstance(names, dict):
            ordered = [names[i] for i in sorted(names.keys())]
        else:
            ordered = list(names)
        sidecar.write_text(json.dumps({"class_names": ordered}, indent=2), encoding="utf-8")
    return onnx_path


def _download_pt(name: str) -> Path:
    _bootstrap_ultralytics_runtime()
    from ultralytics import YOLO

    dst = MODELS_DIR / name
    print(f"  Loading {name} ...", flush=True)
    model = YOLO(name)
    src = getattr(model, "pt_path", None) or getattr(model, "path", None) or getattr(
        model, "ckpt_path", None
    )
    if src is not None:
        src = Path(src)
        if src.is_file() and src.resolve() != dst.resolve():
            shutil.copy2(src, dst)
            print(f"  Copied PT → {dst}")
        elif dst.is_file():
            print(f"  PT already at {dst}")
        else:
            print(f"  PT resolved at {src}")
            return Path(src)
    return dst


def _ensure_auto_annotate_onnx() -> None:
    print(f"Auto-Annotate ONNX targets: {', '.join(AUTO_ANNOTATE_YOLO_ONNX)}", flush=True)
    for pt_name in resolve_auto_annotate_onnx_download():
        pt_path = MODELS_DIR / pt_name
        if not pt_path.is_file():
            pt_path = _download_pt(pt_name)
        imgsz = 224 if "-cls" in pt_name else 640
        onnx_path = pt_path.with_suffix(".onnx")
        print(f"  Exporting {pt_name} → {onnx_path.name} (imgsz={imgsz}) ...", flush=True)
        _export_pt_to_onnx(pt_path, imgsz=imgsz)
        print(f"  ONNX ready: {onnx_path}")


def main() -> int:
    spec = os.environ.get("LAI_PRETRAINED_MODELS", "all")
    models_to_download = resolve_ultralytics_pretrained_spec(spec)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    _bootstrap_ultralytics_runtime()

    try:
        from ultralytics import YOLO  # noqa: F401
    except ImportError:
        print(
            "ultralytics not installed in this container. "
            "Run: docker compose exec worker-gpu python scripts/download_ultralytics_models.py",
            file=sys.stderr,
        )
        return 1

    auto_pts = set(resolve_auto_annotate_onnx_download())
    extra = [m for m in models_to_download if m not in auto_pts]
    pt_ok = False

    if extra:
        print(
            f"LAI_PRETRAINED_MODELS={spec!r} → {len(extra)} extra .pt model(s) → {MODELS_DIR}",
            flush=True,
        )
        for i, name in enumerate(extra, 1):
            try:
                print(f"[{i}/{len(extra)}] {name}", flush=True)
                _download_pt(name)
                pt_ok = True
            except Exception as e:
                print(f"  Skip {name}: {e}", file=sys.stderr)
    elif not auto_pts:
        print(f"LAI_PRETRAINED_MODELS={spec!r} → no extra .pt models", flush=True)

    if not _should_export_auto_annotate_onnx(spec):
        print(
            "Skipping Auto-Annotate ONNX export "
            f"(LAI_PRETRAINED_MODELS={spec!r} is training weights only).",
            flush=True,
        )
        if pt_ok or extra:
            print("Done.")
            return 0
        print("Nothing to download.", file=sys.stderr)
        return 1

    try:
        _ensure_auto_annotate_onnx()
    except Exception as e:
        print(f"Auto-Annotate ONNX export failed: {e}", file=sys.stderr)
        if pt_ok:
            print(
                "Training .pt weights were saved; ONNX is only needed for Auto-Annotate.",
                file=sys.stderr,
            )
            return 0
        return 1

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
