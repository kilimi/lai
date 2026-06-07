"""
Training data visualization utilities.
Creates example images with annotations to verify training data quality,
similar to Ultralytics YOLO's train_batch*.jpg files.
"""
import logging
from pathlib import Path
from typing import Dict, List, Tuple
import random

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def generate_color_palette(num_classes: int) -> List[Tuple[int, int, int]]:
    """Generate distinct colors for each class"""
    colors = []
    for i in range(num_classes):
        # Generate colors using HSV for better distribution
        hue = int((i * 180) / max(num_classes, 1))
        color_hsv = np.uint8([[[hue, 255, 255]]])
        color_bgr = cv2.cvtColor(color_hsv, cv2.COLOR_HSV2BGR)[0][0]
        colors.append((int(color_bgr[0]), int(color_bgr[1]), int(color_bgr[2])))
    return colors


def parse_yolo_label(label_path: Path, img_width: int, img_height: int, is_segmentation: bool = False):
    """
    Parse YOLO format label file.
    
    Format for detection: class_id x_center y_center width height (normalized)
    Format for segmentation: class_id x1 y1 x2 y2 ... (normalized polygon points)
    
    Returns:
        List of annotations as (class_id, coords) where coords format depends on task type
    """
    if not label_path.exists():
        return []
    
    annotations = []
    with open(label_path, 'r') as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 2:
                continue
                
            try:
                class_id = int(float(parts[0]))
            except (TypeError, ValueError):
                continue
            
            try:
                values = [float(x) for x in parts[1:]]
            except (TypeError, ValueError):
                continue
            
            if is_segmentation:
                # Ultralytics segmentation labels store polygon points after class id.
                # Be tolerant to both normalized [0..1] and pixel-coordinate inputs.
                if len(values) < 6 or (len(values) % 2) != 0:
                    continue

                needs_normalization = max((abs(v) for v in values), default=0.0) <= 1.5
                pixel_coords = []
                for i in range(0, len(values), 2):
                    if needs_normalization:
                        x = int(round(values[i] * img_width))
                        y = int(round(values[i + 1] * img_height))
                    else:
                        x = int(round(values[i]))
                        y = int(round(values[i + 1]))

                    x = max(0, min(img_width - 1, x))
                    y = max(0, min(img_height - 1, y))
                    pixel_coords.extend([x, y])

                if len(pixel_coords) < 6:
                    continue
                annotations.append(('segmentation', class_id, pixel_coords))
            else:
                # Detection: class_id x_center y_center width height
                if len(values) == 4:
                    x_center, y_center, width, height = values
                    x1 = int((x_center - width / 2) * img_width)
                    y1 = int((y_center - height / 2) * img_height)
                    x2 = int((x_center + width / 2) * img_width)
                    y2 = int((y_center + height / 2) * img_height)
                elif len(values) >= 6 and len(values) % 2 == 0:
                    # Legacy exports wrote seg polygons for detection jobs — derive a bbox for preview.
                    needs_normalization = max((abs(v) for v in values), default=0.0) <= 1.5
                    xs, ys = [], []
                    for i in range(0, len(values), 2):
                        if needs_normalization:
                            xs.append(values[i] * img_width)
                            ys.append(values[i + 1] * img_height)
                        else:
                            xs.append(values[i])
                            ys.append(values[i + 1])
                    if not xs or not ys:
                        continue
                    x1, y1 = int(min(xs)), int(min(ys))
                    x2, y2 = int(max(xs)), int(max(ys))
                else:
                    continue

                x1 = max(0, min(img_width - 1, x1))
                y1 = max(0, min(img_height - 1, y1))
                x2 = max(0, min(img_width - 1, x2))
                y2 = max(0, min(img_height - 1, y2))
                if x2 <= x1:
                    x2 = min(img_width - 1, x1 + 1)
                if y2 <= y1:
                    y2 = min(img_height - 1, y1 + 1)

                annotations.append(("bbox", class_id, [x1, y1, x2, y2]))
    
    return annotations


def draw_annotations_on_image(img: np.ndarray, annotations: List, 
                              class_names: List[str], colors: List[Tuple[int, int, int]],
                              is_segmentation: bool = False) -> np.ndarray:
    """
    Draw bounding boxes or segmentation masks on image.
    
    Args:
        img: Image array (BGR format)
        annotations: List of (type, class_id, coords)
        class_names: List of class names
        colors: List of BGR colors for each class
        is_segmentation: Whether this is a segmentation task
    """
    img_annotated = img.copy()
    
    for annotation in annotations:
        ann_type, class_id, coords = annotation

        # Be tolerant to class-index mismatches so annotations are still visible.
        if class_id < len(class_names):
            class_name = class_names[class_id]
        else:
            class_name = f"Class {class_id}"

        if colors:
            color = colors[class_id % len(colors)]
        else:
            color = (0, 255, 0)
        
        if ann_type == 'segmentation' and is_segmentation:
            # Draw segmentation polygon
            if len(coords) >= 6:  # Need at least 3 points
                # Reshape to (N, 2) for cv2.polylines
                points = np.array(coords).reshape(-1, 2).astype(np.int32)
                
                # Draw filled polygon with transparency
                overlay = img_annotated.copy()
                cv2.fillPoly(overlay, [points], color)
                cv2.addWeighted(overlay, 0.3, img_annotated, 0.7, 0, img_annotated)
                
                # Draw polygon outline
                cv2.polylines(img_annotated, [points], True, color, 2)
                
                # Draw label at first point
                if len(points) > 0:
                    label_pos = tuple(points[0])
                    # Draw label background
                    (label_w, label_h), _ = cv2.getTextSize(class_name, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                    cv2.rectangle(img_annotated, 
                                (label_pos[0], label_pos[1] - label_h - 4),
                                (label_pos[0] + label_w, label_pos[1]), 
                                color, -1)
                    cv2.putText(img_annotated, class_name, label_pos,
                              cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        
        elif ann_type == 'bbox':
            # Draw bounding box
            x1, y1, x2, y2 = coords
            cv2.rectangle(img_annotated, (x1, y1), (x2, y2), color, 2)
            
            # Draw label
            label = f"{class_name}"
            (label_w, label_h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(img_annotated, (x1, y1 - label_h - 4), (x1 + label_w, y1), color, -1)
            cv2.putText(img_annotated, label, (x1, y1 - 2),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    
    return img_annotated


def draw_classification_label_on_image(
    img: np.ndarray,
    class_name: str,
    color: Tuple[int, int, int],
) -> np.ndarray:
    """Draw a prominent class name banner on an image (YOLO classify layout)."""
    img_annotated = img.copy()
    h, w = img_annotated.shape[:2]
    label = class_name or "unknown"
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = max(0.55, min(w, h) / 420.0)
    thickness = max(1, int(round(scale * 2)))
    (tw, th), baseline = cv2.getTextSize(label, font, scale, thickness)
    band_h = th + baseline + 20
    y0 = max(0, h - band_h)
    cv2.rectangle(img_annotated, (0, y0), (w, h), color, -1)
    x = max(10, (w - tw) // 2)
    y = h - max(10, (band_h - th) // 2)
    cv2.putText(
        img_annotated,
        label,
        (x, y),
        font,
        scale,
        (255, 255, 255),
        thickness,
        cv2.LINE_AA,
    )
    return img_annotated


def create_classification_training_examples(
    dataset_dir: Path,
    output_dir: Path,
    class_names: List[str],
    num_examples: int = 16,
    grid_size: Tuple[int, int] = (4, 4),
) -> None:
    """
    Create preview mosaics for Ultralytics YOLO classification datasets.

    Expects dataset_dir/{train,val,test}/<class_name>/*.jpg
    """
    logger.info(f"Creating classification training examples in {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    colors = generate_color_palette(max(len(class_names), 1))
    name_to_id = {name: idx for idx, name in enumerate(class_names)}

    for split in ("train", "val", "test"):
        split_dir = dataset_dir / split
        if not split_dir.is_dir():
            continue

        class_dirs = sorted(p for p in split_dir.iterdir() if p.is_dir())
        if not class_dirs:
            logger.warning(f"No class folders in classification {split} split: {split_dir}")
            continue

        candidates: List[Tuple[Path, str]] = []
        for class_dir in class_dirs:
            class_name = class_dir.name
            for img_path in class_dir.iterdir():
                if img_path.is_file() and img_path.suffix.lower() in {
                    ".jpg", ".jpeg", ".png", ".bmp", ".webp"
                }:
                    candidates.append((img_path, class_name))

        if not candidates:
            logger.warning(f"No images in classification {split} split")
            continue

        random.shuffle(candidates)
        per_class: Dict[str, List[Tuple[Path, str]]] = {}
        for item in candidates:
            per_class.setdefault(item[1], []).append(item)

        sampled: List[Tuple[Path, str]] = []
        if per_class:
            per_class_quota = max(1, num_examples // len(per_class))
            for class_name, items in per_class.items():
                sampled.extend(random.sample(items, min(per_class_quota, len(items))))
        remaining = num_examples - len(sampled)
        if remaining > 0:
            pool = [c for c in candidates if c not in sampled]
            if pool:
                sampled.extend(random.sample(pool, min(remaining, len(pool))))
        sampled = sampled[:num_examples]

        annotated_images: List[np.ndarray] = []
        for img_path, class_name in sampled:
            img = cv2.imread(str(img_path))
            if img is None:
                logger.warning(f"Could not read classification image: {img_path}")
                continue
            class_id = name_to_id.get(class_name)
            if class_id is None:
                class_id = len(name_to_id)
                name_to_id[class_name] = class_id
                if class_id >= len(colors):
                    colors = generate_color_palette(class_id + 1)
            color = colors[class_id % len(colors)]
            annotated_images.append(
                draw_classification_label_on_image(img, class_name, color)
            )

        if annotated_images:
            legend_names = [name for name, _ in sorted(name_to_id.items(), key=lambda x: x[1])]
            _save_mosaic_grid(
                annotated_images,
                output_dir,
                split,
                legend_names,
                colors,
                grid_size,
            )

    logger.info(f"Classification training examples created in {output_dir}")


def letterbox_image(img: np.ndarray, target_size: Tuple[int, int], pad_color: Tuple[int, int, int] = (114, 114, 114)) -> np.ndarray:
    """Resize while preserving aspect ratio, then pad to target size (Ultralytics-style letterbox)."""
    target_w, target_h = target_size
    src_h, src_w = img.shape[:2]
    if src_h <= 0 or src_w <= 0:
        return np.full((target_h, target_w, 3), pad_color, dtype=np.uint8)

    scale = min(target_w / src_w, target_h / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    canvas = np.full((target_h, target_w, 3), pad_color, dtype=np.uint8)
    x = (target_w - new_w) // 2
    y = (target_h - new_h) // 2
    canvas[y:y + new_h, x:x + new_w] = resized
    return canvas


def _save_mosaic_grid(
    annotated_images: List[np.ndarray],
    output_dir: Path,
    split: str,
    class_names: List[str],
    colors: List[Tuple[int, int, int]],
    grid_size: Tuple[int, int] = (4, 4),
) -> None:
    """Save a titled mosaic grid and individual example thumbnails."""
    rows, cols = grid_size
    num_images = min(len(annotated_images), rows * cols)
    if num_images == 0:
        return

    target_size = (640, 640)
    resized_images = [letterbox_image(img, target_size) for img in annotated_images[:num_images]]
    while len(resized_images) < rows * cols:
        resized_images.append(np.zeros((target_size[1], target_size[0], 3), dtype=np.uint8))

    grid_rows = []
    for i in range(rows):
        row_images = resized_images[i * cols:(i + 1) * cols]
        if row_images:
            grid_rows.append(np.hstack(row_images))

    if not grid_rows:
        return

    grid = np.vstack(grid_rows)

    title_height = 60
    title_img = np.ones((title_height, grid.shape[1], 3), dtype=np.uint8) * 255
    title_text = f"{split.upper()} Batch - {len(annotated_images)} samples"
    cv2.putText(title_img, title_text, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)

    legend_height = 30 + (len(class_names) // 4 + 1) * 25
    legend_img = np.ones((legend_height, grid.shape[1], 3), dtype=np.uint8) * 240
    cv2.putText(legend_img, "Classes:", (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)

    for idx, class_name in enumerate(class_names):
        x = 10 + (idx % 4) * (grid.shape[1] // 4)
        y = 40 + (idx // 4) * 25
        color = colors[idx]
        cv2.rectangle(legend_img, (x, y - 10), (x + 15, y + 5), color, -1)
        cv2.putText(legend_img, class_name, (x + 20, y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)

    final_img = np.vstack([title_img, grid, legend_img])
    output_path = output_dir / f"{split}_batch.jpg"
    cv2.imwrite(str(output_path), final_img)
    logger.info(f"Saved {split} batch examples to {output_path}")

    individual_dir = output_dir / split
    individual_dir.mkdir(exist_ok=True)
    for idx, img in enumerate(annotated_images[: min(3, len(annotated_images))]):
        cv2.imwrite(str(individual_dir / f"example_{idx + 1}.jpg"), img)


def create_coco_training_examples(
    dataset_dir: Path,
    output_dir: Path,
    class_names: List[str],
    num_examples: int = 16,
    grid_size: Tuple[int, int] = (4, 4),
) -> None:
    """
    Create annotated training previews from a COCO-format MMYOLO dataset.

    Expects:
      dataset_dir/annotations/{train,val}.json
      dataset_dir/images/{train,val}/
    """
    import json

    logger.info(f"Creating COCO training examples in {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)
    colors = generate_color_palette(len(class_names))

    for split in ["train", "val", "test"]:
        ann_path = dataset_dir / "annotations" / f"{split}.json"
        images_dir = dataset_dir / "images" / split
        if not ann_path.exists() or not images_dir.exists():
            continue

        with open(ann_path, "r") as f:
            coco = json.load(f)

        anns_by_image: Dict[int, list] = {}
        for ann in coco.get("annotations", []):
            anns_by_image.setdefault(ann["image_id"], []).append(ann)

        image_records = [img for img in coco.get("images", []) if anns_by_image.get(img["id"])]
        if not image_records:
            logger.warning(f"No annotated images in COCO {split} split")
            continue

        sampled = random.sample(image_records, min(num_examples, len(image_records)))
        annotated_images = []
        for img_info in sampled:
            img_path = images_dir / img_info["file_name"]
            if not img_path.exists():
                logger.warning(f"COCO example image missing: {img_path}")
                continue

            img = cv2.imread(str(img_path))
            if img is None:
                continue

            annotations = []
            for ann in anns_by_image.get(img_info["id"], []):
                bbox = ann.get("bbox")
                if not bbox or len(bbox) != 4:
                    continue
                x, y, w, h = bbox
                x1, y1 = int(x), int(y)
                x2, y2 = int(x + w), int(y + h)
                class_id = max(0, int(ann.get("category_id", 1)) - 1)
                annotations.append(("bbox", class_id, [x1, y1, x2, y2]))

            annotated_images.append(
                draw_annotations_on_image(img, annotations, class_names, colors, is_segmentation=False)
            )

        if annotated_images:
            _save_mosaic_grid(annotated_images, output_dir, split, class_names, colors, grid_size)


def create_mmyolo_prediction_preview(
    work_dir: Path,
    output_dir: Path,
    max_images: int = 8,
    grid_size: Tuple[int, int] = (4, 4),
) -> bool:
    """
    Build a mosaic from MMYOLO DetVisualizationHook outputs (work_dir/vis_data/).

    Returns True if at least one preview image was written.
    """
    vis_dir = work_dir / "vis_data"
    if not vis_dir.is_dir():
        return False

    image_paths = sorted(
        [
            p
            for p in vis_dir.rglob("*")
            if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
        ],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not image_paths:
        return False

    output_dir.mkdir(parents=True, exist_ok=True)
    loaded: List[np.ndarray] = []
    for path in image_paths[: max_images * 2]:
        img = cv2.imread(str(path))
        if img is not None:
            loaded.append(img)
        if len(loaded) >= max_images:
            break

    if not loaded:
        return False

    rows, cols = grid_size
    target_size = (640, 640)
    resized = [letterbox_image(img, target_size) for img in loaded[: rows * cols]]
    while len(resized) < rows * cols:
        resized.append(np.zeros((target_size[1], target_size[0], 3), dtype=np.uint8))

    grid_rows = []
    for i in range(rows):
        row = resized[i * cols : (i + 1) * cols]
        if row:
            grid_rows.append(np.hstack(row))
    if not grid_rows:
        return False

    grid = np.vstack(grid_rows)
    title_height = 50
    title_img = np.ones((title_height, grid.shape[1], 3), dtype=np.uint8) * 255
    cv2.putText(
        title_img,
        "MMYOLO validation predictions (latest val pass)",
        (20, 35),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (0, 0, 0),
        2,
    )
    final_img = np.vstack([title_img, grid])
    out_path = output_dir / "val_predictions_batch.jpg"
    cv2.imwrite(str(out_path), final_img)
    logger.info(f"Saved MMYOLO prediction preview to {out_path}")
    return True


def create_training_examples(
    dataset_dir: Path,
    output_dir: Path,
    class_names: List[str],
    num_examples: int = 16,
    is_segmentation: bool = False,
    grid_size: Tuple[int, int] = (4, 4)
) -> None:
    """
    Create example images with annotations from training dataset.
    Similar to Ultralytics YOLO's train_batch*.jpg visualization.
    
    Args:
        dataset_dir: Path to YOLO dataset directory (contains images/ and labels/)
        output_dir: Path to save example visualizations
        class_names: List of class names
        num_examples: Number of examples to create per split
        is_segmentation: Whether this is a segmentation model
        grid_size: Grid layout (rows, cols) for mosaic view
    """
    logger.info(f"Creating training examples in {output_dir}")
    logger.info(f"Dataset directory: {dataset_dir}")
    logger.info(f"Task type: {'segmentation' if is_segmentation else 'detection'}")
    logger.info(f"Classes: {class_names}")
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Generate color palette
    colors = generate_color_palette(len(class_names))
    
    # Process each split
    for split in ['train', 'val', 'test']:
        images_dir = dataset_dir / 'images' / split
        labels_dir = dataset_dir / 'labels' / split
        
        if not images_dir.exists():
            logger.warning(f"Images directory not found: {images_dir}")
            continue
        
        # Get all image files (case-insensitive extensions)
        image_files = [
            p for p in images_dir.iterdir()
            if p.is_file() and p.suffix.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
        ]
        if not image_files:
            logger.warning(f"No images found in {images_dir}")
            continue
        
        logger.info(f"Found {len(image_files)} images in {split} split")
        
        # Prefer labeled images so previews reliably show boxes/masks.
        labeled_images = []
        unlabeled_images = []
        for img_path in image_files:
            label_path = labels_dir / f"{img_path.stem}.txt"
            if label_path.exists() and label_path.stat().st_size > 0:
                labeled_images.append(img_path)
            else:
                unlabeled_images.append(img_path)

        num_to_sample = min(num_examples, len(image_files))
        sample_labeled = min(num_to_sample, len(labeled_images))
        sampled_images = random.sample(labeled_images, sample_labeled) if sample_labeled > 0 else []
        remaining = num_to_sample - len(sampled_images)
        if remaining > 0 and unlabeled_images:
            sampled_images.extend(random.sample(unlabeled_images, min(remaining, len(unlabeled_images))))

        random.shuffle(sampled_images)
        logger.info(
            f"{split}: sampled {len(sampled_images)} images "
            f"({len([p for p in sampled_images if p in labeled_images])} labeled, "
            f"{len([p for p in sampled_images if p in unlabeled_images])} unlabeled)"
        )
        
        # Create individual annotated images
        annotated_images = []
        total_annotations = 0
        for img_path in sampled_images:
            # Read image
            img = cv2.imread(str(img_path))
            if img is None:
                logger.warning(f"Could not read image: {img_path}")
                continue
            
            img_height, img_width = img.shape[:2]
            
            # Get corresponding label file
            label_path = labels_dir / (img_path.stem + '.txt')
            
            # Parse annotations
            annotations = parse_yolo_label(label_path, img_width, img_height, is_segmentation)
            total_annotations += len(annotations)
            
            # Draw annotations
            img_annotated = draw_annotations_on_image(
                img, annotations, class_names, colors, is_segmentation
            )
            
            annotated_images.append(img_annotated)
        
        if not annotated_images:
            logger.warning(f"No valid annotated images for {split} split")
            continue

        logger.info(f"{split}: rendered {total_annotations} annotations across {len(annotated_images)} sampled images")
        _save_mosaic_grid(annotated_images, output_dir, split, class_names, colors, grid_size)

    logger.info(f"Training examples created successfully in {output_dir}")
