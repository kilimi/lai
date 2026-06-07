"""Shared helpers for annotation-to-dataset conversion."""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


def generate_safe_output_filename(
    source_filename: str,
    dataset_id: int,
    augmentation_index: Optional[int] = None,
    method_suffix: Optional[str] = None,
) -> str:
    """Safe filename with dataset_id to prevent collisions across datasets."""
    base_name = Path(source_filename).stem
    extension = Path(source_filename).suffix or ".jpg"
    if augmentation_index is not None and method_suffix is not None:
        return f"aug_{augmentation_index}_{method_suffix}_ds{dataset_id}_{base_name}{extension}"
    return f"ds{dataset_id}_{base_name}{extension}"


def collect_class_names(db: Any, dataset_configs: List[Dict[str, Any]]) -> Tuple[List[str], Dict[str, int]]:
    """Collect sorted class names and name->index mapping across dataset configs."""
    from app.models import AnnotationClass, AnnotationFile

    all_classes: Set[str] = set()
    for config in dataset_configs:
        dataset_id = config["dataset_id"]
        annotation_file_id = config["annotation_file_id"]

        annotation_classes = db.query(AnnotationClass).filter(
            AnnotationClass.annotation_file_id == annotation_file_id
        ).all()

        if not annotation_classes:
            annotation_file = db.query(AnnotationFile).filter(
                AnnotationFile.dataset_id == dataset_id
            ).first()
            if annotation_file:
                annotation_classes = db.query(AnnotationClass).filter(
                    AnnotationClass.annotation_file_id == annotation_file.id
                ).all()

        for ann_class in annotation_classes:
            all_classes.add(ann_class.class_name)

    sorted_classes = sorted(all_classes)
    class_mapping = {name: idx for idx, name in enumerate(sorted_classes)}
    return sorted_classes, class_mapping


def resolve_source_image_path(image: Any, dataset_id: int) -> Path:
    """Resolve DB image record to filesystem path under projects/."""
    if image.url:
        if image.url.startswith("/static/projects/"):
            return Path("projects") / image.url.replace("/static/projects/", "")
        if image.url.startswith("projects/"):
            return Path(image.url)
        return Path("projects") / str(dataset_id) / image.file_name
    return Path("projects") / str(dataset_id) / image.file_name


def copy_image_file(src_path: Path, dst_path: Path) -> None:
    """Hard-link or copy image to destination if not already present."""
    if not src_path.exists():
        return
    if dst_path.exists():
        return
    try:
        os.link(src_path, dst_path)
    except OSError:
        shutil.copy2(src_path, dst_path)


def read_image_dimensions(image: Any, file_path: Path, fallback: Tuple[int, int] = (640, 640)) -> Tuple[int, int]:
    """Read width/height from DB or image file."""
    width = image.width
    height = image.height
    if width and height and width > 0 and height > 0:
        return int(width), int(height)
    try:
        from PIL import Image as PILImage

        with PILImage.open(file_path) as pil_img:
            return pil_img.size
    except Exception as err:
        logger.warning("Could not read dimensions for %s: %s", file_path, err)
        return fallback
