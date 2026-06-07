"""Fast batch helpers for dataset list UIs (one preview image per dataset, no N+1 scans)."""
from __future__ import annotations

from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session, load_only

from .models import Image

# Inline data URLs above this size are omitted from list/grid JSON (use file preview instead).
MAX_LIST_VIEW_DATA_URL_CHARS = 500_000


def append_thumb_query_if_relative(url: str | None, thumb: int = 300) -> Optional[str]:
    """
    For same-origin static paths, ensure ``?thumb=`` is present so the file handler
    serves a downscaled image instead of the full-resolution original.
    Leaves ``data:``, ``http(s):``, and blob URLs unchanged.
    """
    if not url:
        return None
    u = url.strip()
    if not u.startswith("/"):
        return u
    if "thumb=" in u:
        return u
    sep = "&" if "?" in u else "?"
    return f"{u}{sep}thumb={thumb}"


def resolve_dataset_list_thumbnail(
    stored_thumb: str | None,
    preview_fallback: str | None,
    *,
    include_base64_thumbnails: bool,
    max_data_url_chars: int = MAX_LIST_VIEW_DATA_URL_CHARS,
) -> Optional[str]:
    """
    Pick a thumbnail URL for dataset cards: prefer stored logo/thumbnail, else first-image preview.

    - Oversized ``data:image/...`` URLs are dropped (legacy full-size base64 logos).
    - Relative ``/static/...`` paths always get ``?thumb=300`` when missing, so the
      browser never downloads multi-megabyte originals for the grid.
    """
    chosen: Optional[str] = None
    if stored_thumb:
        s = stored_thumb.strip()
        if s.startswith("data:image/"):
            if include_base64_thumbnails and len(s) <= max_data_url_chars:
                chosen = s
        else:
            chosen = append_thumb_query_if_relative(s)
    if chosen is None:
        chosen = preview_fallback
    elif not chosen.startswith("data:"):
        chosen = append_thumb_query_if_relative(chosen)
    return chosen


def first_preview_url_by_dataset(db: Session, dataset_ids: List[int]) -> Dict[int, str]:
    """
    For each dataset_id, pick the image with minimum id (stable 'first' image) and build
    a small preview URL (?thumb=300) for relative paths — same convention as datasets router.
    """
    if not dataset_ids:
        return {}
    rows = (
        db.query(Image.dataset_id, func.min(Image.id))
        .filter(Image.dataset_id.in_(dataset_ids))
        .group_by(Image.dataset_id)
        .all()
    )
    if not rows:
        return {}
    min_ids = [mid for (_ds, mid) in rows]
    imgs = (
        db.query(Image)
        .filter(Image.id.in_(min_ids))
        .options(
            load_only(
                Image.id,
                Image.dataset_id,
                Image.url,
                Image.thumbnail_url,
            )
        )
        .all()
    )
    out: Dict[int, str] = {}
    for img in imgs:
        u = img.thumbnail_url or img.url
        if not u:
            continue
        if u.startswith("/"):
            out[img.dataset_id] = append_thumb_query_if_relative(u) or u
        else:
            out[img.dataset_id] = u
    return out
