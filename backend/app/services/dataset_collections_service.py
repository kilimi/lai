"""Default image collection (layer) helpers for new datasets."""
from __future__ import annotations

from sqlalchemy.orm import Session

from app import models

DEFAULT_IMAGE_COLLECTION_NAME = "RGB"


def ensure_default_image_collection(
    db: Session,
    dataset_id: int,
    *,
    name: str = DEFAULT_IMAGE_COLLECTION_NAME,
    description: str = "Default RGB image layer",
) -> models.ImageCollection | None:
    """
    Create the default RGB layer when a dataset has no collections yet.

    Returns the new collection, or None if one already exists.
    """
    existing = (
        db.query(models.ImageCollection)
        .filter(models.ImageCollection.dataset_id == dataset_id)
        .first()
    )
    if existing:
        return None

    collection = models.ImageCollection(
        dataset_id=dataset_id,
        name=name,
        description=description,
        is_default=True,
        position=0,
    )
    db.add(collection)
    db.flush()
    return collection
