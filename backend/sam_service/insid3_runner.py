"""
Lazy-loaded INSID3 inference wrapper for sam_service.

Requires INSID3 code on PYTHONPATH (INSID3_CODE_PATH) and DINOv3 weights (DINOV3_WEIGHTS_DIR).
"""
from __future__ import annotations

import os
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image

from insid3_mask_utils import (
    load_target_image,
    log_reference_entry,
    log_target_entry,
    mask_to_polygon_lists_with_stats,
    normalize_reference_entry,
    reference_entry_diagnostics,
)

INSID3_MODEL = None
INSID3_IMPORT_ERROR: Optional[str] = None
_MODEL_LOCK = threading.Lock()

from dinov3_weight_utils import CANONICAL_FILENAMES, canonical_filename

_WEIGHT_FILENAMES = CANONICAL_FILENAMES

_SESSIONS: Dict[str, "_Insid3Session"] = {}
_SESSION_TTL_SEC = 3600


@dataclass
class _Insid3Session:
    refs: List[dict]
    image_size: int
    model_size: str
    min_area: float
    created_at: float = field(default_factory=time.time)


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _insid3_code_path() -> str:
    return os.environ.get("INSID3_CODE_PATH", "/opt/insid3")


def _dinov3_weights_dir() -> str:
    return os.environ.get("DINOV3_WEIGHTS_DIR", "/models/dinov3")


def _ensure_insid3_path() -> None:
    code_path = _insid3_code_path()
    if not code_path or not os.path.isdir(code_path):
        return
    # Must precede /app on sys.path so INSID3's `utils` package is not shadowed by sam_service modules.
    while code_path in sys.path:
        sys.path.remove(code_path)
    sys.path.insert(0, code_path)
    # A file named utils.py on sys.path (legacy sam_service layout) breaks `from utils.clustering`.
    utils_mod = sys.modules.get("utils")
    if utils_mod is not None and not getattr(utils_mod, "__path__", None):
        del sys.modules["utils"]


def _link_pretrain_weights(model_size: str) -> bool:
    """Ensure INSID3 pretrain/ contains Meta-format DINOv3 weights for torch.hub."""
    import pathlib

    from dinov3_weight_utils import (
        diagnose_checkpoint,
        ensure_meta_checkpoint_file,
        format_mismatch_help,
        invalidate_cached_meta_conversion,
        list_dinov3_pth_files,
        resolve_dinov3_weight_path,
    )

    code_path = pathlib.Path(_insid3_code_path())
    pretrain = code_path / "pretrain"
    pretrain.mkdir(parents=True, exist_ok=True)
    fname = canonical_filename(model_size)
    target = pretrain / fname
    meta_cache = pretrain / f"{fname}.meta-converted.pth"
    weights_dir = _dinov3_weights_dir()

    if target.is_file():
        status, detail = diagnose_checkpoint(str(target), model_size)
        if status == "ok":
            return True
        print(f"[DINOv3] stale/broken pretrain checkpoint ({status}): {detail}")
        invalidate_cached_meta_conversion(str(pretrain), model_size)
        target.unlink(missing_ok=True)
        meta_cache.unlink(missing_ok=True)

    src_path = resolve_dinov3_weight_path(weights_dir, model_size)
    if src_path is None:
        if target.is_file():
            return True
        found = list_dinov3_pth_files(weights_dir)
        print(
            f"[DINOv3] No checkpoint for model_size={model_size!r} in {weights_dir}. "
            f"Expected {fname} (HF export name dinov3-vitb16-pretrain-lvd1689m.pth also works). "
            f"Found .pth files: {found or '(none)'}"
        )
        return False

    src = pathlib.Path(src_path)
    if src.name != fname:
        print(f"[DINOv3] Using weights file {src.name} (canonical name: {fname})")

    status, detail = diagnose_checkpoint(str(src), model_size)
    print(f"[DINOv3] weights {src.name}: {status}" + (f" ({detail})" if detail else ""))
    if status == "ok":
        if not target.exists():
            try:
                target.symlink_to(src)
            except OSError:
                import shutil

                shutil.copy2(src, target)
        return True

    try:
        ensure_meta_checkpoint_file(str(src), str(target), model_size)
        print(f"[DINOv3] converted checkpoint → {target}")
        return target.is_file()
    except Exception as exc:
        print(f"[DINOv3] {format_mismatch_help(model_size, str(src))}")
        print(f"[DINOv3] Detail: {exc}")
        return False


def insid3_weights_available(model_size: str = "base") -> bool:
    if _env_bool("INSID3_SKIP_WEIGHTS_CHECK"):
        return True
    from dinov3_weight_utils import resolve_dinov3_weight_path

    if resolve_dinov3_weight_path(_dinov3_weights_dir(), model_size):
        return True
    fname = canonical_filename(model_size)
    pretrain = os.path.join(_insid3_code_path(), "pretrain", fname)
    return os.path.isfile(pretrain)


def insid3_ready_for_api(model_size: str = "base") -> bool:
    if not _env_bool("INSID3_ENABLED", True):
        return False
    if not os.path.isdir(_insid3_code_path()):
        return False
    if not insid3_weights_available(model_size):
        return False
    _ensure_insid3_path()
    try:
        from models import build_insid3  # noqa: F401
        return True
    except Exception as e:
        global INSID3_IMPORT_ERROR
        INSID3_IMPORT_ERROR = str(e)
        return False


def insid3_status_for_health(model_size: str = "base") -> dict:
    """Structured INSID3 readiness for /health (weights vs import/setup)."""
    weights_dir = _dinov3_weights_dir()
    fname = _WEIGHT_FILENAMES.get(model_size, _WEIGHT_FILENAMES["base"])
    return {
        "available": insid3_ready_for_api(model_size),
        "weights_path": os.path.join(weights_dir, fname),
        "weights_available": insid3_weights_available(model_size),
        "code_path": _insid3_code_path(),
        "enabled": _env_bool("INSID3_ENABLED", True),
        "error": INSID3_IMPORT_ERROR,
    }

def log_dinov3_startup_status(default_model_size: str = "base") -> None:
    """Print DINOv3 / INSID3 availability at sam_service startup (mirrors SAM3 checkpoint logs)."""
    from dinov3_weight_utils import list_dinov3_pth_files, resolve_dinov3_weight_path

    weights_dir = _dinov3_weights_dir()
    fname = canonical_filename(default_model_size)
    resolved = resolve_dinov3_weight_path(weights_dir, default_model_size)
    pretrain_path = os.path.join(_insid3_code_path(), "pretrain", fname)
    weight_exists = resolved is not None or os.path.isfile(pretrain_path)
    resolved_name = os.path.basename(resolved) if resolved else None
    print(
        f"[DINOv3] DINOV3_WEIGHTS_DIR={weights_dir}, canonical={fname}, "
        f"resolved={resolved_name}, exists={weight_exists}"
    )
    if not weight_exists:
        print(f"[DINOv3] .pth in mount: {list_dinov3_pth_files(weights_dir) or '(none)'}")
    if not weight_exists:
        print(
            "[DINOv3] Default INSID3 weights missing — place the .pth in DINOV3_WEIGHTS_DIR "
            "(see lai install / README)."
        )

    code_path = _insid3_code_path()
    code_exists = os.path.isdir(code_path)
    enabled = _env_bool("INSID3_ENABLED", True)
    ready = insid3_ready_for_api(default_model_size) if enabled else False
    print(f"[INSID3] INSID3_CODE_PATH={code_path}, exists={code_exists}, INSID3_ENABLED={enabled}, ready_for_api={ready}")
    if enabled and not ready and INSID3_IMPORT_ERROR:
        print(f"[INSID3] Setup note: {INSID3_IMPORT_ERROR}")


def _get_device():
    import torch

    if _env_bool("SAM_FORCE_CPU", False):
        return torch.device("cpu")
    try:
        if not torch.cuda.is_available():
            return torch.device("cpu")
        torch.zeros(1, device="cuda")
        return torch.device("cuda")
    except Exception:
        return torch.device("cpu")


def _load_model(image_size: int = 768, model_size: str = "base"):
    global INSID3_MODEL, INSID3_IMPORT_ERROR
    with _MODEL_LOCK:
        if INSID3_MODEL is not None:
            return INSID3_MODEL
        _ensure_insid3_path()
        if not _link_pretrain_weights(model_size):
            raise FileNotFoundError(
                f"DINOv3 weights for {model_size} not found or invalid. "
                "Run: python backend/scripts/download_dinov3_models.py "
                "or download from https://dl.fbaipublicfiles.com/dinov3/dinov3_vitb16/"
                "dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth"
            )
        from models import build_insid3

        device = _get_device()
        old_cwd = os.getcwd()
        try:
            os.chdir(_insid3_code_path())
            model = build_insid3(
                model_size=model_size,
                image_size=image_size,
                mask_refiner="bilinear",
                resize_to_orig_size=True,
                device=str(device),
            )
        except Exception as e:
            global INSID3_IMPORT_ERROR
            INSID3_IMPORT_ERROR = str(e)
            from dinov3_weight_utils import format_mismatch_help

            fname = _WEIGHT_FILENAMES.get(model_size, _WEIGHT_FILENAMES["base"])
            weight_path = os.path.join(_dinov3_weights_dir(), fname)
            print(f"[INSID3] Model load failed: {e}")
            print(f"[DINOv3] {format_mismatch_help(model_size, weight_path)}")
            raise
        finally:
            os.chdir(old_cwd)
        model.eval()
        INSID3_MODEL = model
        print(f"[INSID3] Model loaded ({model_size}, {image_size}px) on {device}")
        return INSID3_MODEL


def _purge_stale_sessions() -> None:
    now = time.time()
    stale = [k for k, s in _SESSIONS.items() if now - s.created_at > _SESSION_TTL_SEC]
    for k in stale:
        _SESSIONS.pop(k, None)


def create_session(
    references: List[dict],
    image_size: int = 768,
    model_size: str = "base",
    min_area: float = 0.0,
) -> str:
    if not references:
        raise ValueError("At least one reference is required")
    _purge_stale_sessions()
    sid = str(uuid.uuid4())
    _SESSIONS[sid] = _Insid3Session(
        refs=list(references),
        image_size=image_size,
        model_size=model_size,
        min_area=min_area,
    )
    return sid


def _segment_outcome(
    *,
    ref_diags: List[dict],
    pred_positive: int,
    post_stats: dict,
    polygon_count: int,
    min_area: float,
) -> tuple[str, str]:
    empty_refs = [d for d in ref_diags if d.get("warning") == "empty_reference_mask"]
    if empty_refs:
        names = ", ".join(str(d.get("imageName") or f"#{d.get('index')}") for d in empty_refs[:3])
        suffix = "…" if len(empty_refs) > 3 else ""
        return (
            "empty_reference_mask",
            f"{len(empty_refs)} reference mask(s) rasterize to 0 pixels ({names}{suffix}). "
            "Re-pick references on the image or check width/height alignment.",
        )
    if pred_positive == 0:
        return (
            "empty_model_mask",
            "INSID3 found no similar region on this image (model mask is empty). "
            "Try different reference examples or objects that look more alike in the layer.",
        )
    if polygon_count == 0 and int(post_stats.get("skippedByMinArea") or 0) > 0 and min_area > 0:
        skipped = int(post_stats.get("skippedByMinArea") or 0)
        return (
            "filtered_by_min_area",
            f"Model detected region(s) but {skipped} component(s) were below min_area={min_area:g} px².",
        )
    if polygon_count == 0 and pred_positive > 0:
        return (
            "no_polygons",
            "Model produced a mask but polygon export returned nothing (unexpected post-processing).",
        )
    return ("match", f"Exported {polygon_count} polygon(s).")


def _run_segment(references: List[dict], target_ref: dict, image_size: int, model_size: str, min_area: float):
    import torch
    from PIL import Image as PILImage

    print(
        f"[INSID3] segment start: refs={len(references)} model={model_size} "
        f"image_size={image_size} min_area={min_area}"
    )
    log_target_entry(target_ref)
    for i, ref in enumerate(references):
        log_reference_entry(ref, i)

    model = _load_model(image_size=image_size, model_size=model_size)
    model.reset_state()

    ref_diags: List[dict] = []
    for i, ref in enumerate(references):
        ref_diags.append(reference_entry_diagnostics(ref, i))
        img_np, mask_np = normalize_reference_entry(ref)
        ref_diags[-1]["maskPixels"] = int((mask_np > 0).sum())
        if ref_diags[-1]["maskPixels"] == 0:
            ref_diags[-1]["warning"] = "empty_reference_mask"
        pil_img = PILImage.fromarray(img_np.astype(np.uint8), mode="RGB")
        mask_bool = torch.from_numpy(mask_np > 0)
        print(
            f"[INSID3] set_reference[{i}]: image={img_np.shape[1]}x{img_np.shape[0]} "
            f"mask_true_pixels={int(mask_bool.sum())}"
        )
        model.set_reference(pil_img, mask_bool)

    tgt_img_np, orig_w, orig_h = load_target_image(target_ref)
    tgt_pil = PILImage.fromarray(tgt_img_np.astype(np.uint8), mode="RGB")
    print(f"[INSID3] set_target: {orig_w}x{orig_h}")
    model.set_target(tgt_pil)
    pred = model.segment()
    if hasattr(pred, "cpu"):
        pred_np = pred.cpu().numpy()
    else:
        pred_np = np.asarray(pred)
    pred_positive = int((pred_np > 0).sum())
    pred_max = float(np.max(pred_np)) if pred_np.size else 0.0
    pred_min = float(np.min(pred_np)) if pred_np.size else 0.0
    print(
        f"[INSID3] model.segment: pred_shape={pred_np.shape} "
        f"positive_pixels={pred_positive} min={pred_min:.4f} max={pred_max:.4f}"
    )
    pred_u8 = (pred_np > 0).astype(np.uint8) * 255
    polys, post_stats = mask_to_polygon_lists_with_stats(pred_u8, orig_w, orig_h, min_area=min_area)
    outcome, reason = _segment_outcome(
        ref_diags=ref_diags,
        pred_positive=pred_positive,
        post_stats=post_stats,
        polygon_count=len(polys),
        min_area=min_area,
    )
    if pred_positive == 0:
        print("[INSID3] WARNING: model returned empty mask — no similar region detected")
    elif len(polys) == 0:
        print("[INSID3] WARNING: model mask non-empty but no polygons after post-processing")
    else:
        print(f"[INSID3] segment done: {len(polys)} polygon(s) exported")

    diagnostics = {
        "settings": {
            "modelSize": model_size,
            "imageSize": image_size,
            "minArea": float(min_area),
        },
        "references": ref_diags,
        "target": {"width": orig_w, "height": orig_h},
        "inference": {
            "positivePixels": pred_positive,
            "predMin": round(pred_min, 6),
            "predMax": round(pred_max, 6),
        },
        "postprocess": post_stats,
        "outcome": outcome,
        "reason": reason,
    }
    return polys, pred_u8, orig_w, orig_h, diagnostics


def segment_from_references(
    references: List[dict],
    target: dict,
    image_size: int = 768,
    model_size: str = "base",
    min_area: float = 0.0,
) -> dict:
    """Run INSID3 with 1+ references against one target image."""
    if not insid3_ready_for_api(model_size):
        detail = INSID3_IMPORT_ERROR or "INSID3 not available"
        raise RuntimeError(detail)

    polys, pred_u8, orig_w, orig_h, diagnostics = _run_segment(
        references, target, image_size, model_size, min_area
    )
    from sam_utils import encode_image_to_dataurl

    mask_pil = Image.fromarray(pred_u8).convert("RGBA")
    return {
        "polygons": polys,
        "maskBase64": encode_image_to_dataurl(mask_pil),
        "source": "insid3",
        "referenceCount": len(references),
        "width": orig_w,
        "height": orig_h,
        "diagnostics": diagnostics,
    }


def segment_with_session(session_id: str, target: dict) -> dict:
    session = _SESSIONS.get(session_id)
    if not session:
        raise KeyError("INSID3 session not found or expired")
    return segment_from_references(
        session.refs,
        target,
        image_size=session.image_size,
        model_size=session.model_size,
        min_area=session.min_area,
    )
