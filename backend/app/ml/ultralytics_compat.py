"""Compatibility shims for Ultralytics 8.4.11+ lazy model exports."""
from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_PATCHED = False
_MATPLOTLIB_PATCHED = False

YOLO26_MIN_ULTRALYTICS = (8, 4, 0)


def _parse_version_tuple(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in (version or "").strip().split("."):
        match = re.match(r"(\d+)", chunk)
        if not match:
            break
        parts.append(int(match.group(1)))
    return tuple(parts)


def get_ultralytics_version(*, prefer_subprocess_site: bool = True) -> tuple[int, ...] | None:
    """Return installed ultralytics version as (major, minor, patch), or None."""
    try:
        if prefer_subprocess_site:
            from app.ml.runtime_env import ensure_ultralytics_sys_path

            ensure_ultralytics_sys_path()
        import ultralytics

        return _parse_version_tuple(getattr(ultralytics, "__version__", ""))
    except Exception as exc:
        logger.debug("ultralytics version unavailable: %s", exc)
        return None


def ultralytics_supports_yolo26() -> bool:
    """YOLO26 weights need ultralytics>=8.4.0 (C3k2 blocks, end2end head)."""
    version = get_ultralytics_version()
    return version is not None and version >= YOLO26_MIN_ULTRALYTICS


def model_type_requires_yolo26(model_path_or_type: str) -> bool:
    name = Path(str(model_path_or_type or "")).name.lower()
    return "yolo26" in name


def assert_ultralytics_supports_model(model_path_or_type: str) -> None:
    """
    Fail fast when YOLO26 is requested on an older ultralytics runtime.

    Raises RuntimeError with rebuild instructions.
    """
    if not model_type_requires_yolo26(model_path_or_type):
        return
    if ultralytics_supports_yolo26():
        return
    try:
        import ultralytics

        installed = getattr(ultralytics, "__version__", "unknown")
    except Exception:
        installed = "not installed"
    raise RuntimeError(
        f"YOLO26 training requires ultralytics>=8.4.0 (installed: {installed}). "
        "Rebuild the GPU stack: "
        "docker compose build ultralytics_runtime worker-gpu && "
        "docker compose up -d worker-gpu"
    )


def patch_matplotlib_for_headless() -> None:
    """
    Configure matplotlib for headless Docker training and tolerate broken fonts.

    Ultralytics registers TTF files from its config dir before plotting (PR curves,
    etc.). A corrupted or partial download raises RuntimeError and fails training
    after all epochs complete. Skip unreadable fonts and fall back to DejaVu Sans.
    """
    global _MATPLOTLIB_PATCHED
    if _MATPLOTLIB_PATCHED:
        return

    try:
        import matplotlib

        matplotlib.use("Agg", force=False)
    except Exception as exc:
        logger.debug("matplotlib Agg backend not set: %s", exc)

    try:
        from matplotlib import font_manager
    except Exception as exc:
        logger.debug("matplotlib font_manager unavailable: %s", exc)
        _MATPLOTLIB_PATCHED = True
        return

    original_addfont = font_manager.fontManager.addfont

    def safe_addfont(path: str) -> None:
        try:
            original_addfont(path)
        except (OSError, RuntimeError) as exc:
            logger.warning("Skipping unreadable font %s: %s", path, exc)

    font_manager.fontManager.addfont = safe_addfont  # type: ignore[method-assign]
    _MATPLOTLIB_PATCHED = True


def patch_ultralytics_lazy_exports() -> None:
    """
    Ultralytics 8.4.11+ exposes YOLO/RTDETR via __getattr__ only.

    That breaks `from ultralytics import YOLO` used inside ultralytics itself
    (e.g. check_amp during training). Eagerly attach model classes to the package.
    """
    global _PATCHED
    if _PATCHED:
        return
    try:
        import ultralytics
    except Exception as exc:
        logger.debug("ultralytics not available for compat patch: %s", exc)
        return

    exports = (
        ("YOLO", "ultralytics.models.yolo.model", "YOLO"),
        ("RTDETR", "ultralytics.models", "RTDETR"),
    )
    for attr, module_path, class_name in exports:
        if getattr(ultralytics, attr, None) is not None:
            continue
        try:
            mod = __import__(module_path, fromlist=[class_name])
            cls = getattr(mod, class_name)
            setattr(ultralytics, attr, cls)
        except Exception as exc:
            logger.debug("Could not patch ultralytics.%s: %s", attr, exc)

    _PATCHED = True
