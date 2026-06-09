#!/usr/bin/env python3
"""
Script to fix annotation segmentation coordinates that are outside image bounds.
This fixes negative coordinates and coordinates that exceed image dimensions.
"""
import sys
import os
from pathlib import Path
import numpy as np

# Add the app directory to the path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationFile
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def fix_annotation_coordinates(dataset_id: int, dry_run: bool = False):
    """Fix annotation segmentation coordinates for a dataset."""
    db: Session = SessionLocal()
    
    try:
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            logger.error(f"Dataset {dataset_id} not found")
            return
        
        logger.info(f"=== Fixing annotations for Dataset: {dataset.name} (ID: {dataset_id}) ===")
        logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE UPDATE'}\n")
        
        # Get all annotations with segmentation for this dataset
        annotations = db.query(Annotation).join(
            Image, Annotation.image_id == Image.id
        ).filter(
            Image.dataset_id == dataset_id,
            Annotation.segmentation.isnot(None)
        ).all()
        
        logger.info(f"Found {len(annotations)} annotations with segmentation")
        
        fixed_count = 0
        skipped_count = 0
        error_count = 0
        
        for ann in annotations:
            try:
                # Get the associated image to know dimensions
                image = db.query(Image).filter(Image.id == ann.image_id).first()
                if not image:
                    logger.warning(f"Annotation {ann.id}: Image not found, skipping")
                    skipped_count += 1
                    continue
                
                img_width = image.width or 1
                img_height = image.height or 1
                
                if not ann.segmentation:
                    continue
                
                # Process segmentation (COCO format: list of polygons, each polygon is a flat list)
                original_seg = ann.segmentation
                fixed_seg = []
                needs_fixing = False
                
                if not isinstance(original_seg, list):
                    logger.warning(f"Annotation {ann.id}: Invalid segmentation format (not a list)")
                    skipped_count += 1
                    continue
                
                for polygon_idx, polygon in enumerate(original_seg):
                    if not isinstance(polygon, list):
                        logger.warning(f"Annotation {ann.id}, polygon {polygon_idx}: Invalid format (not a list)")
                        continue
                    
                    if len(polygon) < 6:  # Need at least 3 points (6 values)
                        logger.warning(f"Annotation {ann.id}, polygon {polygon_idx}: Too few points ({len(polygon)} values)")
                        continue
                    
                    # Process points in pairs (x, y)
                    fixed_polygon = []
                    valid_points = 0
                    points_filtered = 0
                    
                    for i in range(0, len(polygon), 2):
                        if i + 1 >= len(polygon):
                            break
                        
                        x = float(polygon[i])
                        y = float(polygon[i + 1])
                        
                        # Check if point is way outside bounds (more than 10% outside)
                        margin = max(img_width, img_height) * 0.1
                        if x < -margin or x > img_width + margin or y < -margin or y > img_height + margin:
                            points_filtered += 1
                            needs_fixing = True
                            continue
                        
                        # Check for NaN or Inf
                        if np.isnan(x) or np.isnan(y) or np.isinf(x) or np.isinf(y):
                            points_filtered += 1
                            needs_fixing = True
                            continue
                        
                        # Clamp to image bounds
                        clamped_x = max(0.0, min(x, float(img_width - 1)))
                        clamped_y = max(0.0, min(y, float(img_height - 1)))
                        
                        # Check if clamping was needed
                        if clamped_x != x or clamped_y != y:
                            needs_fixing = True
                        
                        fixed_polygon.extend([clamped_x, clamped_y])
                        valid_points += 1
                    
                    # Only keep polygon if it has at least 3 valid points
                    if valid_points >= 3 and len(fixed_polygon) >= 6:
                        fixed_seg.append(fixed_polygon)
                    else:
                        logger.warning(f"Annotation {ann.id}, polygon {polygon_idx}: Insufficient valid points after filtering ({valid_points} points, need at least 3)")
                        needs_fixing = True
                
                # Update annotation if it was fixed
                if needs_fixing:
                    if len(fixed_seg) > 0:
                        if not dry_run:
                            ann.segmentation = fixed_seg
                            db.add(ann)
                            fixed_count += 1
                            logger.info(f"✓ Fixed annotation {ann.id} (image: {image.file_name}, category: {ann.category})")
                            logger.info(f"  Filtered {points_filtered} invalid points, kept {sum(len(p)//2 for p in fixed_seg)} valid points")
                        else:
                            fixed_count += 1
                            logger.info(f"[DRY RUN] Would fix annotation {ann.id} (image: {image.file_name}, category: {ann.category})")
                            logger.info(f"  Would filter {points_filtered} invalid points, would keep {sum(len(p)//2 for p in fixed_seg)} valid points")
                    else:
                        # All polygons were invalid - remove segmentation
                        if not dry_run:
                            ann.segmentation = None
                            db.add(ann)
                            logger.warning(f"⚠ Removed invalid segmentation from annotation {ann.id} (no valid polygons)")
                        else:
                            logger.warning(f"[DRY RUN] Would remove invalid segmentation from annotation {ann.id} (no valid polygons)")
                        error_count += 1
                else:
                    skipped_count += 1
                    
            except Exception as e:
                logger.error(f"Error processing annotation {ann.id}: {e}")
                error_count += 1
                import traceback
                traceback.print_exc()
        
        # Commit changes if not dry run
        if not dry_run and fixed_count > 0:
            db.commit()
            logger.info(f"\n✓ Committed {fixed_count} fixed annotations to database")
        elif dry_run:
            logger.info(f"\n[DRY RUN] Would fix {fixed_count} annotations")
        
        logger.info(f"\n=== Summary ===")
        logger.info(f"Fixed: {fixed_count}")
        logger.info(f"Skipped (no changes needed): {skipped_count}")
        logger.info(f"Errors/Removed: {error_count}")
        logger.info(f"Total processed: {len(annotations)}")
        
    except Exception as e:
        logger.error(f"Error: {e}")
        import traceback
        traceback.print_exc()
        if not dry_run:
            db.rollback()
    finally:
        db.close()


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Fix annotation segmentation coordinates')
    parser.add_argument('dataset_id', type=int, help='Dataset ID to fix')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be fixed without making changes')
    
    args = parser.parse_args()
    
    fix_annotation_coordinates(args.dataset_id, dry_run=args.dry_run)
