"""YOLO format dataset writer for Ultralytics training."""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List

from app.models import Annotation, AnnotationClass, AnnotationFile, Dataset, Image, ImageCollection
from app.ml.dataset.builder import generate_safe_output_filename, resolve_source_image_path
from app.ml.dataset.formats.coco import _coco_bbox_from_annotation

logger = logging.getLogger(__name__)


def _yolo_detection_line_from_bbox(
    class_id: int,
    *,
    x: float,
    y: float,
    w: float,
    h: float,
    coords_are_normalized: bool,
    img_width: int,
    img_height: int,
) -> str:
    """Format one YOLO detection label line (class + normalized xywh center)."""
    if coords_are_normalized:
        x_center = x + w / 2
        y_center = y + h / 2
        norm_w, norm_h = w, h
    else:
        x_center = (x + w / 2) / img_width
        y_center = (y + h / 2) / img_height
        norm_w = w / img_width
        norm_h = h / img_height
    return f"{class_id} {x_center:.6f} {y_center:.6f} {norm_w:.6f} {norm_h:.6f}"


def _append_yolo_detection_bbox(
    label_lines: List[str],
    annotation: Annotation,
    *,
    class_id: int,
    img_width: int,
    img_height: int,
    stats: Dict[str, Any],
    split_name: str,
    class_name: str,
) -> bool:
    """Append a detection label — prefers normalized bbox_* columns, then COCO bbox JSON, then mask envelope."""
    coco_bbox = _coco_bbox_from_annotation(annotation, img_width, img_height)
    if not coco_bbox or coco_bbox[2] <= 0 or coco_bbox[3] <= 0:
        return False

    x, y, w, h = coco_bbox
    label_lines.append(
        _yolo_detection_line_from_bbox(
            class_id,
            x=float(x),
            y=float(y),
            w=float(w),
            h=float(h),
            coords_are_normalized=False,
            img_width=img_width,
            img_height=img_height,
        )
    )
    if class_name not in stats["annotations_per_class"]:
        stats["annotations_per_class"][class_name] = {"train": 0, "val": 0, "test": 0}
    stats["annotations_per_class"][class_name][split_name] += 1
    stats["total_annotations"][split_name] += 1
    return True


def _detection_annotation_exportable(annotation: Annotation, img_width: int, img_height: int) -> bool:
    """True when this annotation can produce a YOLO detection label line."""
    if _is_classification_label_annotation(annotation):
        return False
    coco_bbox = _coco_bbox_from_annotation(annotation, img_width, img_height)
    return bool(coco_bbox and coco_bbox[2] > 0 and coco_bbox[3] > 0)


def _annotation_has_bbox(annotation: Annotation) -> bool:
    if annotation.bbox and isinstance(annotation.bbox, list) and len(annotation.bbox) >= 4:
        return any(float(v) > 0 for v in annotation.bbox[:4])
    return (
        annotation.bbox_x is not None
        and annotation.bbox_width is not None
        and float(annotation.bbox_width or 0) > 0
        and float(annotation.bbox_height or 0) > 0
    )


def _annotation_has_segmentation(annotation: Annotation) -> bool:
    seg = annotation.segmentation
    return bool(seg and isinstance(seg, list) and len(seg) > 0)


def _is_classification_label_annotation(annotation: Annotation) -> bool:
    """Image-level class label without spatial geometry."""
    if _annotation_has_bbox(annotation) or _annotation_has_segmentation(annotation):
        return False
    return annotation.category_id is not None or bool(annotation.category)


def _safe_class_dirname(class_name: str) -> str:
    safe = "".join(c if c.isalnum() or c in ("-", "_", " ") else "_" for c in class_name.strip())
    return safe or "unknown_class"


_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def _split_dir_has_images(directory: Path) -> bool:
    if not directory.is_dir():
        return False
    return any(
        p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS for p in directory.iterdir()
    )


def _count_labeled_image_pairs(images_dir: Path, labels_dir: Path) -> int:
    if not images_dir.is_dir() or not labels_dir.is_dir():
        return 0
    count = 0
    for img in images_dir.iterdir():
        if not img.is_file() or img.suffix.lower() not in _IMAGE_EXTENSIONS:
            continue
        label_path = labels_dir / f"{img.stem}.txt"
        if label_path.is_file() and label_path.stat().st_size > 0:
            count += 1
    return count


def _compute_split_sizes(total_count: int, split: Dict[str, Any]) -> tuple[int, int, int]:
    """
    Compute train/val/test counts from percentages.

    Tiny datasets often round val to 0; Ultralytics 8.4+ requires a non-empty val
    source, so reserve at least one validation image when possible.
    """
    if total_count <= 0:
        return 0, 0, 0

    train_pct = int(split.get("train", 80))
    val_pct = int(split.get("val", 20))

    train_count = int(total_count * train_pct / 100)
    val_count = int(total_count * val_pct / 100)
    test_count = total_count - train_count - val_count

    if train_count == 0:
        train_count = 1
        if val_count > 0:
            val_count -= 1
        elif test_count > 0:
            test_count -= 1

    if val_pct > 0 and val_count == 0 and total_count >= 2:
        if train_count > 1:
            train_count -= 1
            val_count = 1
        elif test_count > 0:
            test_count -= 1
            val_count = 1

    return train_count, val_count, test_count


def _resolve_yolo_val_path(output_dir: Path, *, total_val_count: int) -> str:
    """Return relative val path for data.yaml, falling back to train when val is empty."""
    val_dir = output_dir / "images" / "val"
    if total_val_count > 0 and _split_dir_has_images(val_dir):
        return "images/val"
    logger.warning(
        "Validation split is empty; using train images for val in data.yaml "
        "(Ultralytics requires at least one validation image)."
    )
    return "images/train"


def _mirror_classification_val_from_train(output_dir: Path) -> None:
    """Hard-link train class folders into val when the val split would otherwise be empty."""
    train_root = output_dir / "train"
    val_root = output_dir / "val"
    if not train_root.is_dir():
        return
    for class_dir in train_root.iterdir():
        if not class_dir.is_dir():
            continue
        target = val_root / class_dir.name
        target.mkdir(parents=True, exist_ok=True)
        for img in class_dir.iterdir():
            if not img.is_file() or img.suffix.lower() not in _IMAGE_EXTENSIONS:
                continue
            link = target / img.name
            if link.exists():
                continue
            try:
                os.link(img, link)
            except OSError:
                shutil.copy2(img, link)


def _write_yolo_data_yaml(
    yaml_path: Path,
    *,
    abs_path: Path,
    train: str,
    val: str,
    test: str | None,
    class_mapping: Dict[str, int],
    is_segmentation_model: bool,
) -> None:
    with open(yaml_path, "w") as f:
        f.write(f"path: {abs_path}\n")
        f.write(f"train: {train}\n")
        f.write(f"val: {val}\n")
        if test:
            f.write(f"test: {test}\n")
        if is_segmentation_model:
            f.write("task: segment\n")
        f.write(f"nc: {len(class_mapping)}\n")
        f.write("names:\n")
        for name, idx in sorted(class_mapping.items(), key=lambda kv: kv[1]):
            f.write(f"  {idx}: {name}\n")


def _prepare_yolo_classification_dataset(
    db,
    dataset_configs: List[Dict[str, Any]],
    output_dir: Path,
    *,
    remove_images_without_annotations: bool = True,
) -> Dict[str, Any]:
    """
    Build Ultralytics classification layout: train/<class>/img.jpg, val/<class>/img.jpg.
    """
    stats = {
        "total_images": {"train": 0, "val": 0, "test": 0},
        "total_annotations": {"train": 0, "val": 0, "test": 0},
        "annotations_per_class": {},
        "images_filtered": 0,
        "images_processed": 0,
    }
    total_images = {"train": 0, "val": 0, "test": 0}

    for split in ("train", "val", "test"):
        (output_dir / split).mkdir(parents=True, exist_ok=True)

    all_classes: set[str] = set()
    for config in dataset_configs:
        annotation_file_id = config["annotation_file_id"]
        annotation_classes = db.query(AnnotationClass).filter(
            AnnotationClass.annotation_file_id == annotation_file_id
        ).all()
        for ann_class in annotation_classes:
            all_classes.add(ann_class.class_name)

    sorted_classes = sorted(all_classes)
    if not sorted_classes:
        raise ValueError(
            "No annotation classes found. Make sure your classification dataset has class labels defined."
        )

    for config in dataset_configs:
        dataset_id = config["dataset_id"]
        annotation_file_id = config["annotation_file_id"]
        image_collection = config.get("image_collection")
        split = config.get("split", {"train": 80, "val": 20, "test": 0})

        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            logger.warning(f"Dataset {dataset_id} not found, skipping")
            continue

        images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
        if image_collection:
            images_query = images_query.join(Image.collection).filter(
                ImageCollection.name == image_collection
            )
        images = images_query.all()
        if not images:
            logger.warning(f"No images found for dataset {dataset_id}, skipping")
            continue

        if remove_images_without_annotations:
            filtered: list[Image] = []
            for img in images:
                annotations = db.query(Annotation).filter(
                    Annotation.image_id == img.id,
                    Annotation.annotation_file_id == annotation_file_id,
                ).all()
                if any(_is_classification_label_annotation(a) for a in annotations):
                    filtered.append(img)
            stats["images_filtered"] += len(images) - len(filtered)
            images = filtered
            if not images:
                logger.warning(
                    f"No classification labels for dataset {dataset_id} after filtering, skipping"
                )
                continue

        total_count = len(images)
        train_count, val_count, _test_count = _compute_split_sizes(total_count, split)
        train_images = images[:train_count]
        val_images = images[train_count : train_count + val_count]
        test_images = images[train_count + val_count :]

        for split_name, split_images in (
            ("train", train_images),
            ("val", val_images),
            ("test", test_images),
        ):
            for image in split_images:
                src_image_path = resolve_source_image_path(image, dataset_id)
                if src_image_path is None or not src_image_path.exists():
                    logger.warning(f"Image file not found for image {image.id}")
                    continue

                annotations = db.query(Annotation).filter(
                    Annotation.image_id == image.id,
                    Annotation.annotation_file_id == annotation_file_id,
                ).all()
                class_labels: list[str] = []
                for annotation in annotations:
                    if not _is_classification_label_annotation(annotation):
                        continue
                    ann_class = db.query(AnnotationClass).filter(
                        AnnotationClass.annotation_file_id == annotation_file_id,
                        AnnotationClass.category_id == annotation.category_id,
                    ).first()
                    label = (
                        ann_class.class_name
                        if ann_class
                        else (annotation.category or "").strip()
                    )
                    if label and label not in class_labels:
                        class_labels.append(label)

                if not class_labels:
                    continue

                class_name = class_labels[0]
                if len(class_labels) > 1:
                    logger.warning(
                        "Image %s has multiple classification labels %s; using %s",
                        image.id,
                        class_labels,
                        class_name,
                    )

                class_dir = output_dir / split_name / _safe_class_dirname(class_name)
                class_dir.mkdir(parents=True, exist_ok=True)
                safe_filename = generate_safe_output_filename(src_image_path.name, image.dataset_id)
                dst_image_path = class_dir / safe_filename
                try:
                    if not dst_image_path.exists():
                        os.link(src_image_path, dst_image_path)
                except OSError:
                    shutil.copy2(src_image_path, dst_image_path)

                stats["total_images"][split_name] += 1
                stats["images_processed"] += 1
                stats["total_annotations"][split_name] += 1
                if class_name not in stats["annotations_per_class"]:
                    stats["annotations_per_class"][class_name] = {"train": 0, "val": 0, "test": 0}
                stats["annotations_per_class"][class_name][split_name] += 1
                total_images[split_name] += 1

    if total_images["train"] == 0 and total_images["val"] == 0:
        raise ValueError(
            "No images were processed. Classification training requires image-level class labels "
            "(no bounding boxes or polygons). Check that your annotation file is a classification export."
        )

    if not _split_dir_has_images(output_dir / "val") and _split_dir_has_images(output_dir / "train"):
        _mirror_classification_val_from_train(output_dir)
        logger.warning(
            "Classification val split was empty; mirrored train images into val for Ultralytics."
        )

    abs_path = output_dir.absolute()
    if not str(abs_path).startswith("/app/"):
        abs_path = Path("/app") / output_dir

    logger.info(
        "Classification dataset: %s train, %s val, %s test images; classes=%s",
        total_images["train"],
        total_images["val"],
        total_images["test"],
        sorted_classes,
    )

    return {
        "yaml_path": str(abs_path),
        "dataset_format": "classify",
        "class_names": sorted_classes,
        "class_count": len(sorted_classes),
        "image_counts": total_images,
        "dataset_stats": stats,
    }


def prepare_yolo_dataset(
    db,
    dataset_configs: List[Dict[str, Any]],
    output_dir: Path,
    model_type: str = "yolo11n-seg.pt",
    remove_images_without_annotations: bool = True
) -> Dict[str, Any]:
    """
    Prepare YOLO format dataset from database annotations.
    
    Args:
        db: Database session
        dataset_configs: List of dataset configurations
        output_dir: Output directory for the dataset
        model_type: YOLO model type (e.g., 'yolo11n-seg.pt' for segmentation)
    
    Returns:
        Dict with paths and class names
    """
    if "-cls" in model_type.lower():
        return _prepare_yolo_classification_dataset(
            db,
            dataset_configs,
            output_dir,
            remove_images_without_annotations=remove_images_without_annotations,
        )

    # Determine if this is a segmentation model
    is_segmentation_model = '-seg' in model_type.lower()
    
    # Track skipped annotations
    skipped_annotations = {'missing_seg': 0, 'missing_bbox': 0, 'missing_both': 0}
    
    # Statistics tracking
    stats = {
        'total_images': {"train": 0, "val": 0, "test": 0},
        'total_annotations': {"train": 0, "val": 0, "test": 0},
        'annotations_per_class': {},  # Will be filled during processing
        'images_filtered': 0,  # Images removed due to no valid annotations
        'images_processed': 0,
    }
    
    # Create directory structure
    train_images_dir = output_dir / "images" / "train"
    val_images_dir = output_dir / "images" / "val"
    test_images_dir = output_dir / "images" / "test"
    train_labels_dir = output_dir / "labels" / "train"
    val_labels_dir = output_dir / "labels" / "val"
    test_labels_dir = output_dir / "labels" / "test"
    
    for directory in [train_images_dir, val_images_dir, test_images_dir, 
                     train_labels_dir, val_labels_dir, test_labels_dir]:
        directory.mkdir(parents=True, exist_ok=True)
    
    # Collect all classes across all datasets
    all_classes = set()
    class_mapping = {}
    
    # Track annotation types for validation
    has_segmentation = False
    has_bbox_only = False
    
    # First pass: collect all unique classes
    for config in dataset_configs:
        dataset_id = config['dataset_id']
        annotation_file_id = config['annotation_file_id']
        
        logger.info(f"Looking for annotation classes - dataset_id: {dataset_id}, annotation_file_id: {annotation_file_id}")
        
        # Get annotation classes
        annotation_classes = db.query(AnnotationClass).filter(
            AnnotationClass.annotation_file_id == annotation_file_id
        ).all()
        
        logger.info(f"Found {len(annotation_classes)} annotation classes for annotation_file_id: {annotation_file_id}")
        
        if not annotation_classes:
            # Try to find the annotation file first
            annotation_file = db.query(AnnotationFile).filter(
                AnnotationFile.dataset_id == dataset_id
            ).first()
            
            if annotation_file:
                logger.info(f"Found annotation file with id: {annotation_file.id}, name: {annotation_file.name}")
                # Retry with the correct ID
                annotation_classes = db.query(AnnotationClass).filter(
                    AnnotationClass.annotation_file_id == annotation_file.id
                ).all()
                logger.info(f"Found {len(annotation_classes)} annotation classes using annotation_file.id")
        
        for ann_class in annotation_classes:
            all_classes.add(ann_class.class_name)
            logger.info(f"Added class: {ann_class.class_name}")
    
    logger.info(f"Total unique classes found: {len(all_classes)} - {sorted(list(all_classes))}")
    
    # Create class mapping (sorted for consistency)
    sorted_classes = sorted(list(all_classes))
    class_mapping = {class_name: idx for idx, class_name in enumerate(sorted_classes)}
    
    # Process each dataset configuration
    total_images = {"train": 0, "val": 0, "test": 0}
    
    for config in dataset_configs:
        dataset_id = config['dataset_id']
        annotation_file_id = config['annotation_file_id']
        image_collection = config.get('image_collection')
        split = config.get('split', {'train': 80, 'val': 20, 'test': 0})
        
        # Get dataset and images
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            logger.warning(f"Dataset {dataset_id} not found, skipping")
            continue
        
        # Query images, optionally filter by collection
        images_query = db.query(Image).filter(Image.dataset_id == dataset_id)
        if image_collection:
            # Filter by collection name through the relationship
            images_query = images_query.join(Image.collection).filter(
                ImageCollection.name == image_collection
            )
        
        images = images_query.all()
        
        if not images:
            logger.warning(f"No images found for dataset {dataset_id}, skipping")
            continue
        
        # Filter out images without VALID annotations BEFORE splitting (if flag is set)
        if remove_images_without_annotations:
            images_with_annotations = []
            for img in images:
                # Get annotations for this image
                annotations = db.query(Annotation).filter(
                    Annotation.image_id == img.id,
                    Annotation.annotation_file_id == annotation_file_id
                ).all()
                
                img_width = img.width or 0
                img_height = img.height or 0
                if img_width <= 0 or img_height <= 0:
                    src = resolve_source_image_path(img, dataset_id)
                    if src and src.exists():
                        try:
                            from PIL import Image as PILImage
                            with PILImage.open(src) as pil_img:
                                img_width, img_height = pil_img.size
                        except Exception:
                            img_width, img_height = 1, 1

                # Check if ANY annotation meets the requirements
                has_valid_annotation = False
                for annotation in annotations:
                    # For segmentation models, annotation must have BOTH segmentation and bbox
                    if is_segmentation_model:
                        has_seg = annotation.segmentation and len(annotation.segmentation) > 0
                        has_bbox = (annotation.bbox or 
                                   (annotation.bbox_x is not None and annotation.bbox_width is not None))
                        if has_seg and has_bbox:
                            has_valid_annotation = True
                            break
                    elif _detection_annotation_exportable(annotation, img_width, img_height):
                        has_valid_annotation = True
                        break
                
                if has_valid_annotation:
                    images_with_annotations.append(img)
            
            images_before = len(images)
            images = images_with_annotations
            images_after = len(images)
            
            filtered_count = images_before - images_after
            stats['images_filtered'] += filtered_count
            if images_before != images_after:
                logger.info(f"Filtered dataset {dataset_id}: {images_before} → {images_after} images (removed {filtered_count} without valid annotations)")
            
            if not images:
                logger.warning(f"No images with annotations found for dataset {dataset_id} after filtering, skipping")
                continue
        
        # Calculate split indices (ensure tiny datasets still get a val image when possible)
        train_count, val_count, _test_count = _compute_split_sizes(len(images), split)
        
        # Split images
        train_images = images[:train_count]
        val_images = images[train_count:train_count + val_count]
        test_images = images[train_count + val_count:]
        
        # Process each split
        for split_name, split_images, img_dir, lbl_dir in [
            ('train', train_images, train_images_dir, train_labels_dir),
            ('val', val_images, val_images_dir, val_labels_dir),
            ('test', test_images, test_images_dir, test_labels_dir)
        ]:
            for image in split_images:
                src_image_path = resolve_source_image_path(image, dataset_id)
                if src_image_path is None or not src_image_path.exists():
                    logger.warning(f"Image file not found for image {image.id}: {src_image_path}")
                    continue

                img_width = image.width
                img_height = image.height
                if not img_width or not img_height or img_width <= 0 or img_height <= 0:
                    try:
                        from PIL import Image as PILImage
                        with PILImage.open(src_image_path) as pil_img:
                            img_width, img_height = pil_img.size
                    except Exception as dim_err:
                        logger.warning(
                            f"Could not read image dimensions for {src_image_path}: {dim_err}; using 1x1 fallback"
                        )
                        img_width, img_height = 1, 1

                annotations = db.query(Annotation).filter(
                    Annotation.image_id == image.id,
                    Annotation.annotation_file_id == annotation_file_id
                ).all()

                if not annotations:
                    if remove_images_without_annotations:
                        logger.warning(
                            f"Image {image.id} has no annotations but wasn't filtered - this is unexpected"
                        )
                        continue
                    safe_filename = generate_safe_output_filename(src_image_path.name, image.dataset_id)
                    safe_stem = Path(safe_filename).stem
                    dst_image_path = img_dir / safe_filename
                    try:
                        if not dst_image_path.exists():
                            os.link(src_image_path, dst_image_path)
                    except OSError:
                        shutil.copy2(src_image_path, dst_image_path)
                    (lbl_dir / f"{safe_stem}.txt").touch()
                    continue

                label_lines: List[str] = []
                for annotation in annotations:
                    ann_class = db.query(AnnotationClass).filter(
                        AnnotationClass.annotation_file_id == annotation_file_id,
                        AnnotationClass.category_id == annotation.category_id
                    ).first()

                    if not ann_class:
                        continue

                    class_id = class_mapping.get(ann_class.class_name)
                    if class_id is None:
                        continue

                    if is_segmentation_model:
                        has_seg = annotation.segmentation and len(annotation.segmentation) > 0
                        has_bbox = (annotation.bbox or
                                   (annotation.bbox_x is not None and annotation.bbox_width is not None))
                        if not (has_seg and has_bbox):
                            if not has_seg and not has_bbox:
                                skipped_annotations['missing_both'] += 1
                            elif not has_seg:
                                skipped_annotations['missing_seg'] += 1
                            else:
                                skipped_annotations['missing_bbox'] += 1
                            logger.debug(
                                f"Skipping annotation {annotation.id} - missing seg or bbox "
                                f"(has_seg={has_seg}, has_bbox={has_bbox})"
                            )
                            continue

                    class_name = ann_class.class_name

                    if is_segmentation_model and annotation.segmentation:
                        seg = annotation.segmentation
                        if isinstance(seg, list) and len(seg) > 0:
                            if isinstance(seg[0], list):
                                polygon = seg[0]
                            else:
                                polygon = seg

                            if len(polygon) >= 6:
                                needs_normalization = any(abs(val) > 2 for val in polygon)
                                normalized_coords = []
                                if needs_normalization:
                                    for i in range(0, len(polygon), 2):
                                        if i + 1 < len(polygon):
                                            normalized_coords.extend(
                                                [
                                                    polygon[i] / img_width,
                                                    polygon[i + 1] / img_height,
                                                ]
                                            )
                                else:
                                    normalized_coords = polygon

                                if normalized_coords and len(normalized_coords) >= 6:
                                    coords_str = " ".join(f"{c:.6f}" for c in normalized_coords)
                                    label_lines.append(f"{class_id} {coords_str}")
                                    if class_name not in stats["annotations_per_class"]:
                                        stats["annotations_per_class"][class_name] = {
                                            "train": 0,
                                            "val": 0,
                                            "test": 0,
                                        }
                                    stats["annotations_per_class"][class_name][split_name] += 1
                                    stats["total_annotations"][split_name] += 1
                                    has_segmentation = True
                                    continue

                    if _append_yolo_detection_bbox(
                        label_lines,
                        annotation,
                        class_id=class_id,
                        img_width=img_width,
                        img_height=img_height,
                        stats=stats,
                        split_name=split_name,
                        class_name=class_name,
                    ):
                        has_bbox_only = True

                if not label_lines:
                    continue

                safe_filename = generate_safe_output_filename(src_image_path.name, image.dataset_id)
                safe_stem = Path(safe_filename).stem
                dst_image_path = img_dir / safe_filename
                try:
                    if not dst_image_path.exists():
                        os.link(src_image_path, dst_image_path)
                except OSError:
                    shutil.copy2(src_image_path, dst_image_path)

                label_path = lbl_dir / f"{safe_stem}.txt"
                with open(label_path, 'w') as f:
                    f.write('\n'.join(label_lines))
                stats['total_images'][split_name] += 1
                stats['images_processed'] += 1
    
    # Count image/label pairs with non-empty labels (not orphan images).
    for split_name, img_dir, lbl_dir in (
        ("train", train_images_dir, train_labels_dir),
        ("val", val_images_dir, val_labels_dir),
        ("test", test_images_dir, test_labels_dir),
    ):
        labeled = _count_labeled_image_pairs(img_dir, lbl_dir)
        total_images[split_name] = labeled
        stats["total_images"][split_name] = labeled
    # Log annotation type summary
    logger.info(f"Annotation summary - has_segmentation: {has_segmentation}, has_bbox_only: {has_bbox_only}")
    logger.info(f"Model type: {model_type}, is_segmentation_model: {is_segmentation_model}")
    
    # Log skipped annotations
    total_skipped = sum(skipped_annotations.values())
    if total_skipped > 0:
        logger.warning(f"⚠️ Skipped {total_skipped} annotations during dataset preparation:")
        if skipped_annotations['missing_seg'] > 0:
            logger.warning(f"  - {skipped_annotations['missing_seg']} annotations missing segmentation data")
        if skipped_annotations['missing_bbox'] > 0:
            logger.warning(f"  - {skipped_annotations['missing_bbox']} annotations missing bounding box data")
        if skipped_annotations['missing_both'] > 0:
            logger.warning(f"  - {skipped_annotations['missing_both']} annotations missing both segmentation and bbox data")
        logger.warning(f"  Reason: Segmentation models require both polygon and bounding box data for each annotation.")
    
    # Validate annotation format matches model type
    if is_segmentation_model and not has_segmentation:
        if has_bbox_only:
            raise ValueError(
                f"ERROR ❌ Model type '{model_type}' requires segmentation annotations (polygons), "
                f"but only bounding box annotations were found.\n\n"
                f"To fix this:\n"
                f"1. Use a detection model (e.g., 'yolo11n.pt' instead of 'yolo11n-seg.pt'), OR\n"
                f"2. Create segmentation annotations (polygons) for your dataset instead of bounding boxes.\n\n"
                f"See https://docs.ultralytics.com/datasets/segment/ for segmentation dataset format."
            )
        else:
            raise ValueError(
                f"ERROR ❌ No valid annotations found for training.\n"
                f"Model type '{model_type}' requires segmentation annotations (polygons).\n\n"
                f"Please check:\n"
                f"1. Your dataset has annotations uploaded\n"
                f"2. The annotations contain segmentation data (polygons)\n"
                f"3. The annotation file is properly linked to images"
            )
    elif not is_segmentation_model and has_segmentation and not has_bbox_only:
        logger.warning(
            f"Model type '{model_type}' is a detection model, but segmentation annotations were found. "
            f"Consider using a segmentation model (e.g., 'yolo11n-seg.pt') to utilize polygon annotations."
        )
    
    # Create data.yaml file for YOLO
    if not class_mapping:
        raise ValueError("No annotation classes found. Make sure your datasets have annotations with classes defined.")
    
    if total_images['train'] == 0 and total_images['val'] == 0:
        raise ValueError("No images were processed. Check that your datasets have images with annotations.")
    
    # Get absolute path - ensure it starts with /app in Docker context
    abs_path = output_dir.absolute()
    if not str(abs_path).startswith('/app/'):
        # If path is relative or doesn't start with /app, prepend /app
        abs_path = Path('/app') / output_dir
    
    val_rel = _resolve_yolo_val_path(output_dir, total_val_count=total_images["val"])
    test_rel = "images/test" if total_images["test"] > 0 else None

    yaml_content = {
        'path': str(abs_path),
        'train': 'images/train',
        'val': val_rel,
        'test': test_rel,
        'names': {idx: name for name, idx in class_mapping.items()},
        'nc': len(class_mapping)
    }
    
    logger.info(
        "Dataset summary: %s train, %s val, %s test images; data.yaml val=%s",
        total_images['train'],
        total_images['val'],
        total_images['test'],
        val_rel,
    )
    logger.info(f"Classes: {class_mapping}")
    
    yaml_path = output_dir / "data.yaml"
    _write_yolo_data_yaml(
        yaml_path,
        abs_path=abs_path,
        train=yaml_content["train"],
        val=yaml_content["val"],
        test=yaml_content["test"],
        class_mapping=class_mapping,
        is_segmentation_model=is_segmentation_model,
    )
    
    return {
        'yaml_path': str(yaml_path),
        'class_names': sorted_classes,
        'class_count': len(sorted_classes),
        'image_counts': total_images,
        'dataset_stats': stats,
        'val_data_path': val_rel,
    }