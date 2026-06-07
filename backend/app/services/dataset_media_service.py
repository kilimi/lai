"""Dataset thumbnails and logo helpers."""
from __future__ import annotations

import base64
import io
from typing import Optional, Tuple

from PIL import Image
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models


def create_thumbnail_base64(
    image_data: bytes, mime_type: str, max_size: Tuple[int, int] = (200, 200)
) -> str:
    """Create a thumbnail from image bytes; return a data-URL."""
    try:
        img = Image.open(io.BytesIO(image_data))
        if img.mode == "RGBA":
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail(max_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=85, optimize=True)
        thumbnail_base64 = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/jpeg;base64,{thumbnail_base64}"
    except Exception:
        original_base64 = base64.b64encode(image_data).decode()
        return f"data:{mime_type};base64,{original_base64}"


def is_base64_image(url: str | None) -> bool:
    return bool(url and url.startswith("data:image/"))


def truncate_base64_url(url: str | None, include_base64: bool = False) -> str | None:
    if not url:
        return None
    if is_base64_image(url) and not include_base64:
        return None
    return url


def set_random_image_as_logo(
    dataset: models.Dataset, db: Session, base_url: str = ""
) -> None:
    """Set a random dataset image as logo/thumbnail when none is configured."""
    if dataset.thumbnailUrl or dataset.logo_url or dataset.logo:
        return

    random_image = (
        db.query(models.Image)
        .filter(models.Image.dataset_id == dataset.id, models.Image.url.isnot(None))
        .order_by(func.random())
        .first()
    )
    if not random_image or not random_image.url:
        return

    if random_image.url.startswith("/"):
        suffix = "?thumb=300"
        dataset.thumbnailUrl = f"{base_url}{random_image.url}{suffix}" if base_url else random_image.url
        dataset.logo_url = dataset.thumbnailUrl
    else:
        dataset.thumbnailUrl = random_image.url
        dataset.logo_url = random_image.url
    db.commit()
