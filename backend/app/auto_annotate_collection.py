"""Resolve which image collection auto-annotate should scan when the caller omits ``collection_id``."""
from typing import Optional

from sqlalchemy.orm import Session

from app import models


def resolve_auto_annotate_source_collection_id(
    db: Session,
    dataset_id: int,
    requested: Optional[int],
) -> Optional[int]:
    """
    If ``requested`` is set, return it.

    Otherwise, if this dataset has at least one ImageCollection, return the default
    collection's id when ``is_default`` is set; else the smallest id collection.
    That matches UX for tabbed/multi-collection datasets: never scan every collection
    when the UI meant "dataset primary".

    When the dataset has no collections (legacy), return ``None`` so callers can query
    all ``Image`` rows for that dataset.
    """
    if requested is not None:
        return requested

    has_any = (
        db.query(models.ImageCollection.id)
        .filter(models.ImageCollection.dataset_id == dataset_id)
        .first()
    )
    if not has_any:
        return None

    default_coll = (
        db.query(models.ImageCollection)
        .filter(
            models.ImageCollection.dataset_id == dataset_id,
            models.ImageCollection.is_default.is_(True),
        )
        .first()
    )
    if default_coll:
        return default_coll.id

    first_coll = (
        db.query(models.ImageCollection)
        .filter(models.ImageCollection.dataset_id == dataset_id)
        .order_by(models.ImageCollection.id.asc())
        .first()
    )
    return first_coll.id if first_coll else None
