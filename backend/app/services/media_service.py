"""Thumbnail generation and static media helpers."""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

THUMB_SUFFIXES = frozenset([".jpg", ".jpeg", ".png", ".webp"])


def generate_thumbnail_sync(full_path: Path, thumb_path: Path, thumb_size: int) -> bool:
    """
    Generate a thumbnail synchronously (for thread-pool / startup pre-warm).

    Returns True if the thumbnail exists or was created, False on error.
    """
    if thumb_path.exists():
        return True
    try:
        from PIL import Image

        thumb_path.parent.mkdir(exist_ok=True)
        with Image.open(full_path) as img:
            ratio = min(thumb_size / img.width, thumb_size / img.height)
            new_size = (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            thumb_img = img.resize(new_size, Image.Resampling.LANCZOS)
            suffix = full_path.suffix.lower()
            if suffix in (".jpg", ".jpeg") and thumb_img.mode == "RGBA":
                thumb_img = thumb_img.convert("RGB")
            thumb_img.save(thumb_path, quality=85, optimize=True)
        return True
    except Exception as exc:
        logger.warning("Thumbnail generation failed for %s: %s", full_path, exc)
        return False


def etag_for_path(path: Path) -> str | None:
    """Weak ETag from path + mtime for conditional GET."""
    try:
        mtime = path.stat().st_mtime
        return f'"{hashlib.md5(f"{path}{mtime}".encode()).hexdigest()}"'
    except OSError:
        return None


def resolve_thumbnail_path(full_path: Path, thumb_size: int) -> Path:
    """Return cached thumbnail path for ``full_path`` at ``thumb_size`` (capped at 800)."""
    size = min(thumb_size, 800)
    return full_path.parent / ".thumbs" / f"{full_path.stem}_{size}{full_path.suffix.lower()}"


def prewarm_thumbnails(projects_root: Path, size: int = 300) -> None:
    """Walk ``projects/`` and generate missing thumbnails (background thread)."""
    count = generated = 0
    for img_path in projects_root.rglob("*"):
        if img_path.suffix.lower() not in THUMB_SUFFIXES:
            continue
        if ".thumbs" in img_path.parts:
            continue
        count += 1
        thumb_path = img_path.parent / ".thumbs" / f"{img_path.stem}_{size}{img_path.suffix.lower()}"
        if not thumb_path.exists() and generate_thumbnail_sync(img_path, thumb_path, size):
            generated += 1
    if count:
        logger.info(
            "Thumbnail pre-warm complete: %d images scanned, %d new thumbnails generated",
            count,
            generated,
        )
