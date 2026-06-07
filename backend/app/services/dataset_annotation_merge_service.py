"""Dataset domain services (extracted from datasets router)."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import BackgroundTasks, HTTPException, UploadFile
from PIL import Image
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.database import SessionLocal
from app.services.dataset_schemas import MergeAnnotationFilesRequest
from app.task_dispatch import ensure_inline_dispatch_allowed, use_celery_enabled

logger = logging.getLogger(__name__)

from app.task_stop import TaskStopped, check_task_stop, finalize_running_task, task_stop_requested
async def merge_annotation_files_task(
    task_id: int,
    dataset_id: int,
    file_ids: List[str],
    merged_filename: str,
    strategy_cfg: Optional[dict] = None,
):
    """Background task to merge annotation files and create a new merged file"""
    from app.task_stop import TaskStopped, check_task_stop, finalize_running_task, task_stop_requested

    # Use a fresh session inside background task
    db = SessionLocal()
    task = None
    try:
        def _segmentation_polygons(seg_raw):
            """Return segmentation as list-of-polygons (flat coordinate arrays)."""
            if not isinstance(seg_raw, list) or not seg_raw:
                return []
            first = seg_raw[0]
            if isinstance(first, (int, float)):
                return [seg_raw] if len(seg_raw) >= 6 else []
            polys = []
            for poly in seg_raw:
                if isinstance(poly, list) and len(poly) >= 6:
                    polys.append(poly)
            return polys

        def _bbox_from_polygons(polys):
            if not polys:
                return None
            xs = []
            ys = []
            for poly in polys:
                xs.extend(poly[0::2])
                ys.extend(poly[1::2])
            if not xs or not ys:
                return None
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            return [float(min_x), float(min_y), float(max_x - min_x), float(max_y - min_y)]

        def _polygon_area(poly):
            # Shoelace formula for one polygon [x1, y1, x2, y2, ...]
            if not isinstance(poly, list) or len(poly) < 6:
                return 0.0
            pts = list(zip(poly[0::2], poly[1::2]))
            if len(pts) < 3:
                return 0.0
            area2 = 0.0
            for i in range(len(pts)):
                x1, y1 = pts[i]
                x2, y2 = pts[(i + 1) % len(pts)]
                area2 += (x1 * y2) - (x2 * y1)
            return abs(area2) / 2.0

        def _segmentation_area(polys):
            return float(sum(_polygon_area(p) for p in polys))

        # Update task status
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            return
            
        task.status = "running"
        task.started_at = datetime.now(timezone.utc)
        task.progress = 5
        db.commit()

        # Get all annotation files to merge
        annotation_files = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id.in_(file_ids),
            models.AnnotationFile.dataset_id == dataset_id
        ).all()

        if len(annotation_files) < 2:
            raise Exception("At least 2 annotation files are required for merging")

        # Check if files are too large (over 50k annotations total)
        total_annotations = sum(f.annotation_count or 0 for f in annotation_files)
        if total_annotations > 50000:
            print(f"Warning: Large merge operation with {total_annotations} annotations")
            # Update task metadata to reflect large operation
            task.task_metadata = {
                **task.task_metadata,
                "large_operation": True,
                "total_source_annotations": total_annotations,
                "estimated_duration": "5-15 minutes",
                "optimization_enabled": True
            }
            db.commit()

        task.progress = 10
        db.commit()
        check_task_stop(db, task_id)

        # Get all dataset images for mapping (load once, reuse)
        dataset_images = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).all()
        image_lookup = {img.id: img for img in dataset_images}

        task.progress = 15
        db.commit()

        # Initialize merged data structure
        merged_data = {
            "info": {
                "description": f"Merged annotations from {len(annotation_files)} files: {', '.join([f.name for f in annotation_files])}",
                "version": "1.0",
                "year": datetime.now(timezone.utc).year,
                "contributor": "AI Data Creator",
                "date_created": datetime.now(timezone.utc).isoformat()
            },
            "licenses": [{
                "id": 1,
                "name": "Unknown License",
                "url": ""
            }],
            "images": [],
            "categories": [],
            "annotations": []
        }

        # Strategy configuration (defaults match legacy behavior: drop exact dupes)
        scfg = strategy_cfg or {}
        s_strategy = (scfg.get("strategy") or "exact").lower()
        s_iou = float(scfg.get("iou_threshold", 0.5))
        s_tie = (scfg.get("tie_breaker") or "largest").lower()
        s_priority = scfg.get("priority_order") or list(file_ids)
        s_cross = (scfg.get("cross_class") or "keep").lower()
        s_cross_iou = float(scfg.get("cross_class_iou", 0.7))
        # Map file_id -> priority rank (0 = highest)
        priority_rank = {fid: i for i, fid in enumerate(s_priority)}
        for fid in file_ids:
            priority_rank.setdefault(fid, len(priority_rank))

        # Use sets for faster duplicate detection
        category_map = {}  # category_name -> category_id
        image_map = {}     # original_image_id -> new_coco_image_id

        category_id_counter = 1
        image_id_counter = 1
        annotation_id_counter = 1

        # Process files in batches to avoid memory issues
        for file_idx, annotation_file in enumerate(annotation_files):
            check_task_stop(db, task_id)
            try:
                print(f"Processing annotation file: {annotation_file.name} ({annotation_file.annotation_count} annotations)")
                
                # Process categories first (usually small number)
                classes = db.query(models.AnnotationClass).filter(
                    models.AnnotationClass.annotation_file_id == annotation_file.id
                ).all()

                for cls in classes:
                    if cls.class_name not in category_map:
                        category_map[cls.class_name] = category_id_counter
                        merged_data["categories"].append({
                            "id": category_id_counter,
                            "name": cls.class_name,
                            "supercategory": ""
                        })
                        category_id_counter += 1

                # Process annotations in batches to avoid memory overload
                batch_size = 1000  # Process 1000 annotations at a time
                annotation_count = annotation_file.annotation_count or 0
                
                for offset in range(0, annotation_count, batch_size):
                    check_task_stop(db, task_id)
                    # Load annotations in batches
                    annotations_batch = db.query(models.Annotation).filter(
                        models.Annotation.annotation_file_id == annotation_file.id
                    ).offset(offset).limit(batch_size).all()
                    
                    for annotation in annotations_batch:
                        # Handle image mapping (avoid duplicates)
                        original_image_id = annotation.image_id
                        
                        if original_image_id not in image_map:
                            # Add new image entry
                            image_info = image_lookup.get(original_image_id)
                            if image_info:
                                image_map[original_image_id] = image_id_counter
                                merged_data["images"].append({
                                    "id": image_id_counter,
                                    "width": image_info.width or 640,
                                    "height": image_info.height or 480,
                                    "file_name": image_info.file_name,
                                    "license": 1,
                                    "flickr_url": "",
                                    "coco_url": "",
                                    "date_captured": ""
                                })
                                image_id_counter += 1
                            else:
                                # Skip annotation if image not found
                                continue

                        # Create annotation entry
                        coco_image_id = image_map[original_image_id]
                        category_id = category_map.get(annotation.category, category_map.get("unknown", 1))

                        # Get image dimensions for bbox conversion
                        image_info = image_lookup.get(original_image_id)
                        img_width = image_info.width if image_info else 640
                        img_height = image_info.height if image_info else 480

                        # Convert bbox properly
                        pixel_bbox = [0, 0, 0, 0]
                        if annotation.bbox and len(annotation.bbox) >= 4:
                            bbox = annotation.bbox
                            # Check if bbox is normalized (values between 0 and 1)
                            if all(0 <= coord <= 1 for coord in bbox):
                                # Convert normalized to pixel coordinates
                                pixel_bbox = [
                                    bbox[0] * img_width,   # x
                                    bbox[1] * img_height,  # y
                                    bbox[2] * img_width,   # width
                                    bbox[3] * img_height   # height
                                ]
                            else:
                                # Already in pixel coordinates
                                pixel_bbox = list(bbox[:4])
                        elif (
                            annotation.bbox_x is not None
                            and annotation.bbox_y is not None
                            and annotation.bbox_width is not None
                            and annotation.bbox_height is not None
                        ):
                            # Legacy normalized bbox fields.
                            pixel_bbox = [
                                float(annotation.bbox_x) * img_width,
                                float(annotation.bbox_y) * img_height,
                                float(annotation.bbox_width) * img_width,
                                float(annotation.bbox_height) * img_height,
                            ]

                        seg_raw = annotation.segmentation
                        seg_polys = _segmentation_polygons(seg_raw)
                        # If bbox is missing/empty, derive it from segmentation so merge strategy
                        # and exported COCO have usable geometry.
                        if (not pixel_bbox or pixel_bbox[2] <= 0 or pixel_bbox[3] <= 0) and seg_polys:
                            # Detect normalized segmentation by coordinate range.
                            flat = [v for p in seg_polys for v in p]
                            is_norm = bool(flat) and all(0 <= float(v) <= 1 for v in flat)
                            if is_norm:
                                seg_for_bbox = []
                                for poly in seg_polys:
                                    den = []
                                    for i in range(0, len(poly), 2):
                                        den.append(float(poly[i]) * img_width)
                                        den.append(float(poly[i + 1]) * img_height)
                                    seg_for_bbox.append(den)
                            else:
                                seg_for_bbox = [[float(v) for v in poly] for poly in seg_polys]
                            bbox_from_seg = _bbox_from_polygons(seg_for_bbox)
                            if bbox_from_seg:
                                pixel_bbox = bbox_from_seg

                        bbox_area = float(pixel_bbox[2] * pixel_bbox[3]) if pixel_bbox else 0.0
                        ann_area = float(annotation.area) if annotation.area is not None else 0.0
                        if ann_area <= 0 and seg_polys:
                            flat = [v for p in seg_polys for v in p]
                            is_norm = bool(flat) and all(0 <= float(v) <= 1 for v in flat)
                            if is_norm:
                                denorm_polys = []
                                for poly in seg_polys:
                                    den = []
                                    for i in range(0, len(poly), 2):
                                        den.append(float(poly[i]) * img_width)
                                        den.append(float(poly[i + 1]) * img_height)
                                    denorm_polys.append(den)
                                ann_area = _segmentation_area(denorm_polys)
                            else:
                                ann_area = _segmentation_area(seg_polys)
                        if ann_area <= 0:
                            ann_area = bbox_area

                        merged_annotation = {
                            "id": annotation_id_counter,
                            "image_id": coco_image_id,
                            "category_id": category_id,
                            "bbox": pixel_bbox,
                            "area": ann_area,
                            "iscrowd": 0,
                            # Internal tags used by the strategy resolver below; stripped before write.
                            "_source_file_id": annotation_file.id,
                            "_priority": priority_rank.get(annotation_file.id, 9999),
                            "_order": annotation_id_counter,
                        }

                        # Denormalize segmentation from database (stored as 0-1) to pixel coordinates
                        if annotation.segmentation:
                            if isinstance(annotation.segmentation, list):
                                denormalized_segmentation = []
                                for polygon in annotation.segmentation:
                                    if isinstance(polygon, list) and len(polygon) >= 6:
                                        is_norm_poly = all(0 <= float(v) <= 1 for v in polygon)
                                        denormalized_polygon = []
                                        for i in range(0, len(polygon), 2):
                                            x_val = float(polygon[i])
                                            y_val = float(polygon[i + 1]) if i + 1 < len(polygon) else 0.0
                                            if is_norm_poly:
                                                denormalized_polygon.append(x_val * img_width)
                                                denormalized_polygon.append(y_val * img_height)
                                            else:
                                                # Already in pixel coordinates.
                                                denormalized_polygon.append(x_val)
                                                denormalized_polygon.append(y_val)
                                        denormalized_segmentation.append(denormalized_polygon)
                                merged_annotation["segmentation"] = denormalized_segmentation
                            else:
                                # RLE or other format - keep as-is
                                merged_annotation["segmentation"] = annotation.segmentation

                        merged_data["annotations"].append(merged_annotation)
                        annotation_id_counter += 1

                    # Update progress within file processing
                    file_progress = 20 + (file_idx * 60 // len(annotation_files)) + ((offset + batch_size) * 60 // len(annotation_files) // annotation_count)
                    task.progress = min(file_progress, 80)
                    db.commit()

                print(f"Completed processing {annotation_file.name}: {len([a for a in merged_data['annotations'] if a.get('_source_file') == annotation_file.name])} annotations")

            except Exception as file_error:
                print(f"Error processing file {annotation_file.name}: {file_error}")
                continue

        task.progress = 82
        db.commit()
        check_task_stop(db, task_id)

        # ----- Strategy-aware resolution on bboxes -----
        # Bbox IoU helper (COCO format [x, y, w, h])
        def _bbox_iou(a, b):
            ax1, ay1, aw, ah = a[0], a[1], a[2], a[3]
            bx1, by1, bw, bh = b[0], b[1], b[2], b[3]
            ax2, ay2 = ax1 + aw, ay1 + ah
            bx2, by2 = bx1 + bw, by1 + bh
            ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
            ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
            iw = max(0.0, ix2 - ix1); ih = max(0.0, iy2 - iy1)
            inter = iw * ih
            ua = max(0.0, aw * ah) + max(0.0, bw * bh) - inter
            return (inter / ua) if ua > 0 else 0.0

        def _area(a):
            return max(0.0, a["bbox"][2]) * max(0.0, a["bbox"][3])

        def _better(keep, cand, mode):
            # Return True if cand should replace keep
            if mode == "largest":
                return _area(cand) > _area(keep)
            if mode == "smallest":
                return _area(cand) < _area(keep)
            if mode == "first":
                return cand["_order"] < keep["_order"]
            if mode == "last":
                return cand["_order"] > keep["_order"]
            return False

        removed_exact = 0
        removed_iou = 0
        removed_cross_class = 0

        if s_strategy != "union":
            # Group annotations by image
            by_image: dict = {}
            for ann in merged_data["annotations"]:
                by_image.setdefault(ann["image_id"], []).append(ann)

            resolved: list = []
            for img_id, anns in by_image.items():
                # Same-class dedup
                kept_same: list = []
                # Bucket by category
                by_cat: dict = {}
                for a in anns:
                    by_cat.setdefault(a["category_id"], []).append(a)

                for cat_id, group in by_cat.items():
                    keepers: list = []
                    for cand in group:
                        merged_into = None
                        for idx, k in enumerate(keepers):
                            iou_val = _bbox_iou(cand["bbox"], k["bbox"])
                            if s_strategy == "exact":
                                if iou_val >= 0.95:
                                    merged_into = idx
                                    break
                            elif s_strategy == "iou":
                                if iou_val >= s_iou:
                                    merged_into = idx
                                    break
                            elif s_strategy == "priority":
                                if iou_val >= max(0.01, min(s_iou, 0.99)):
                                    merged_into = idx
                                    break
                        if merged_into is None:
                            keepers.append(cand)
                        else:
                            k = keepers[merged_into]
                            if s_strategy == "priority":
                                if cand["_priority"] < k["_priority"]:
                                    keepers[merged_into] = cand
                                elif cand["_priority"] == k["_priority"] and _better(k, cand, s_tie):
                                    keepers[merged_into] = cand
                            elif s_strategy == "iou":
                                if _better(k, cand, s_tie):
                                    keepers[merged_into] = cand
                            # exact: keep first; drop cand
                            if s_strategy == "exact":
                                removed_exact += 1
                            elif s_strategy == "iou":
                                removed_iou += 1
                            else:
                                removed_iou += 1
                    kept_same.extend(keepers)

                # Cross-class resolution (only if priority mode chosen)
                if s_cross == "priority" and len(kept_same) > 1:
                    final_list: list = []
                    # Sort by priority so higher priority is processed first
                    kept_sorted = sorted(kept_same, key=lambda x: (x["_priority"], x["_order"]))
                    for cand in kept_sorted:
                        drop = False
                        for k in final_list:
                            if k["category_id"] == cand["category_id"]:
                                continue
                            if _bbox_iou(cand["bbox"], k["bbox"]) >= s_cross_iou:
                                if cand["_priority"] > k["_priority"]:
                                    drop = True
                                    removed_cross_class += 1
                                    break
                        if not drop:
                            final_list.append(cand)
                    resolved.extend(final_list)
                else:
                    resolved.extend(kept_same)

            # Reassign sequential ids and strip internal tags
            resolved.sort(key=lambda x: (x["image_id"], x["_order"]))
            for new_id, a in enumerate(resolved, start=1):
                a["id"] = new_id
                a.pop("_source_file_id", None)
                a.pop("_priority", None)
                a.pop("_order", None)
            merged_data["annotations"] = resolved
        else:
            # union: just strip tags
            for a in merged_data["annotations"]:
                a.pop("_source_file_id", None)
                a.pop("_priority", None)
                a.pop("_order", None)

        # Record strategy + counts into COCO info for traceability
        merged_data["info"].update({
            "merge_strategy": s_strategy,
            "merge_iou_threshold": s_iou,
            "merge_tie_breaker": s_tie,
            "merge_cross_class": s_cross,
            "merge_cross_class_iou": s_cross_iou,
            "merge_priority_order": s_priority,
            "merge_removed_exact": removed_exact,
            "merge_removed_iou": removed_iou,
            "merge_removed_cross_class": removed_cross_class,
        })

        task.progress = 85
        db.commit()
        check_task_stop(db, task_id)

        # Create the merged annotation file record
        import uuid
        merged_file_id = str(uuid.uuid4())[:8]
        
        # Calculate final statistics
        final_annotation_count = len(merged_data["annotations"])
        final_image_count = len({
            a.get("image_id") for a in merged_data["annotations"] if a.get("image_id") is not None
        })
        final_category_count = len(merged_data["categories"])
        
        print(f"Merge summary: {final_annotation_count} annotations, {final_image_count} images, {final_category_count} categories")
        
        # Detect type for merged annotation file
        from app.services.annotation_processing import detect_annotation_type
        detected_type = detect_annotation_type(merged_data)
        
        merged_annotation_file = models.AnnotationFile(
            id=merged_file_id,
            dataset_id=dataset_id,
            name=merged_filename,
            format='COCO',
            type=detected_type,  # Set type based on detection
            file_size=0,  # Will be updated after processing
            annotation_count=final_annotation_count,
            image_count=final_image_count,
            category_count=final_category_count,
            is_processed=False,
            processing_status="pending"
        )
        
        db.add(merged_annotation_file)
        db.commit()

        task.progress = 90
        db.commit()

        # For very large files, we should process them directly rather than re-parsing
        if final_annotation_count > 10000:
            print(f"Large merge detected ({final_annotation_count} annotations), using direct processing")
            # Process directly without going through COCO parsing again
            await process_merged_data_directly(db, merged_file_id, merged_data)
        else:
            # Use existing processing for smaller files
            from app.services.annotation_processing import process_coco_annotation_file
            await process_coco_annotation_file(merged_file_id, merged_data)

        task.task_metadata = {
            **(task.task_metadata or {}),
            "merged_file_id": merged_file_id,
            "total_images": final_image_count,
            "total_annotations": final_annotation_count,
            "total_categories": final_category_count,
            "source_files": [f.name for f in annotation_files],
            "duplicates_removed": total_annotations - final_annotation_count,
        }
        db.commit()
        finalize_running_task(db, task_id)

        print(f"Annotation merge completed: {final_annotation_count} annotations, {final_image_count} images, {final_category_count} categories")

    except TaskStopped:
        if task is not None:
            db.refresh(task)
            if task.status != "stopped":
                task.status = "stopped"
            if not task.completed_at:
                task.completed_at = datetime.now(timezone.utc)
            db.commit()
        print(f"Annotation merge stopped for task {task_id}")
    except Exception as e:
        if task is not None and not task_stop_requested(task):
            task.status = "failed"
            task.completed_at = datetime.now(timezone.utc)
            task.error_message = str(e)
            task.progress = 0
            db.commit()

        print(f"Error in merge_annotation_files_task: {e}")
        raise
    finally:
        db.close()


async def process_merged_data_directly(db: Session, merged_file_id: str, merged_data: dict):
    """Process merged data directly for large files to avoid memory issues"""
    try:
        annotation_file = db.query(models.AnnotationFile).filter(models.AnnotationFile.id == merged_file_id).first()
        if not annotation_file:
            return
            
        annotation_file.processing_status = "processing"
        db.commit()

        # Clear any existing data
        db.query(models.Annotation).filter(models.Annotation.annotation_file_id == merged_file_id).delete()
        db.query(models.AnnotationClass).filter(models.AnnotationClass.annotation_file_id == merged_file_id).delete()

        # Process categories
        for category in merged_data["categories"]:
            annotation_class = models.AnnotationClass(
                annotation_file_id=merged_file_id,
                class_name=category["name"],
                category_id=category["id"],
                count=0,  # Will be updated when processing annotations
                color='#ea384c',
                opacity=0.25
            )
            db.add(annotation_class)

        # Process annotations in batches to avoid memory issues
        batch_size = 500
        class_counts = {}
        
        for i in range(0, len(merged_data["annotations"]), batch_size):
            batch = merged_data["annotations"][i:i + batch_size]
            
            for ann_data in batch:
                # Find the category name
                category_id = ann_data["category_id"]
                category_name = next((cat["name"] for cat in merged_data["categories"] if cat["id"] == category_id), "unknown")
                
                # Find the image info
                image_id = ann_data["image_id"]
                image_info = next((img for img in merged_data["images"] if img["id"] == image_id), None)
                
                if not image_info:
                    continue
                
                # Convert bbox back to normalized coordinates
                bbox = ann_data.get("bbox", [0, 0, 0, 0])
                img_width = image_info.get("width", 640)
                img_height = image_info.get("height", 480)
                
                normalized_bbox = [
                    bbox[0] / img_width if img_width > 0 else 0,
                    bbox[1] / img_height if img_height > 0 else 0,
                    bbox[2] / img_width if img_width > 0 else 0,
                    bbox[3] / img_height if img_height > 0 else 0
                ] if bbox else None

                # Validate segmentation coordinates before saving
                segmentation = ann_data.get("segmentation")
                if segmentation:
                    from app.services.annotation_processing import validate_and_normalize_segmentation
                    validated_seg = validate_and_normalize_segmentation(
                        segmentation,
                        image_width=img_width,
                        image_height=img_height,
                        normalize=False  # Keep as pixel coordinates (integers)
                    )
                    if validated_seg is not None:
                        segmentation = validated_seg
                    else:
                        segmentation = None
                
                # Create annotation record
                annotation = models.Annotation(
                    annotation_file_id=merged_file_id,
                    image_id=None,  # We'll need to map this to actual dataset image ID
                    dataset_id=annotation_file.dataset_id,
                    coco_image_id=image_id,
                    coco_annotation_id=ann_data.get("id"),
                    category_id=category_id,
                    category=category_name,
                    bbox_x=normalized_bbox[0] if normalized_bbox else None,
                    bbox_y=normalized_bbox[1] if normalized_bbox else None,
                    bbox_width=normalized_bbox[2] if normalized_bbox else None,
                    bbox_height=normalized_bbox[3] if normalized_bbox else None,
                    bbox=bbox,
                    segmentation=segmentation,
                    area=ann_data.get("area"),
                    confidence=1.0
                )
                
                db.add(annotation)
                class_counts[category_name] = class_counts.get(category_name, 0) + 1
            
            # Commit in batches
            db.commit()

        # Update class counts
        for class_name, count in class_counts.items():
            annotation_class = db.query(models.AnnotationClass).filter(
                models.AnnotationClass.annotation_file_id == merged_file_id,
                models.AnnotationClass.class_name == class_name
            ).first()
            if annotation_class:
                annotation_class.count = count

        # Mark as completed
        annotation_file.is_processed = True
        annotation_file.processing_status = "completed"
        db.commit()

    except Exception as e:
        if annotation_file:
            annotation_file.processing_status = "failed"
            annotation_file.error_message = str(e)
            db.commit()
        raise


async def start_annotation_merge(
    db: Session,
    dataset_id: int,
    request: MergeAnnotationFilesRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    try:
        # Verify dataset exists
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Verify annotation files exist
        annotation_files = db.query(models.AnnotationFile).filter(
            models.AnnotationFile.id.in_(request.annotation_file_ids),
            models.AnnotationFile.dataset_id == dataset_id
        ).all()
        
        if len(annotation_files) != len(request.annotation_file_ids):
            raise HTTPException(status_code=404, detail="One or more annotation files not found")
        
        if len(annotation_files) < 2:
            raise HTTPException(status_code=400, detail="At least 2 annotation files are required for merging")

        from app.services.annotation_processing import (
            resolve_annotation_file_merge_type,
            validate_annotation_files_merge_compatible,
        )
        merge_types = [resolve_annotation_file_merge_type(db, f) for f in annotation_files]
        validate_annotation_files_merge_compatible(merge_types)
        
        # Generate merged filename if not provided
        merged_filename = request.merged_filename
        if not merged_filename:
            file_names = [f.name.replace('.json', '').replace('.coco', '') for f in annotation_files]
            merged_filename = f"merged_{'_'.join(file_names)}.json"
        
        # Create task
        task = models.Task(
            name=f"Merge Annotations: {merged_filename}",
            description=f"Merging {len(annotation_files)} annotation files into {merged_filename}",
            task_type="annotation_merge",
            status="pending",
            project_id=dataset.project_id,
            progress=0.0,
            task_metadata={
                "dataset_id": dataset_id,
                "annotation_file_ids": request.annotation_file_ids,
                "merged_filename": merged_filename,
                "source_files": [f.name for f in annotation_files]
            }
        )
        
        db.add(task)
        db.commit()
        db.refresh(task)
        
        task_id = task.id
        strategy_cfg = request.strategy.model_dump() if request.strategy else None

        if use_celery_enabled():
            from app.tasks.annotation_tasks import merge_annotation_files

            celery_job = merge_annotation_files.delay(
                task_id,
                dataset_id,
                request.annotation_file_ids,
                merged_filename,
                strategy_cfg,
            )
            task.task_metadata = {
                **(task.task_metadata or {}),
                "celery_task_id": celery_job.id,
            }
            db.commit()
        else:
            ensure_inline_dispatch_allowed("Annotation merge")
            await merge_annotation_files_task(
                task_id=task_id,
                dataset_id=dataset_id,
                file_ids=request.annotation_file_ids,
                merged_filename=merged_filename,
                strategy_cfg=strategy_cfg,
            )
        
        return {
            "success": True,
            "task_id": task_id,
            "message": f"Annotation merge task started for {len(annotation_files)} files",
            "merged_filename": merged_filename
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in start_annotation_merge: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start merge task: {str(e)}")
