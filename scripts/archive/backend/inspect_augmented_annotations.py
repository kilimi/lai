#!/usr/bin/env python3
"""
Script to inspect augmented dataset annotations and verify segmentation format.
Run this to check if segmentation is stored correctly in COCO format.
"""
import sys
import os
from pathlib import Path

# Add the app directory to the path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationFile
import json

def inspect_annotations(dataset_id: int, limit: int = 5):
    """Inspect annotations for a dataset to verify segmentation format."""
    db: Session = SessionLocal()
    
    try:
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            print(f"Dataset {dataset_id} not found")
            return
        
        print(f"\n=== Inspecting Dataset: {dataset.name} (ID: {dataset_id}) ===\n")
        
        # Get annotation files for this dataset
        annotation_files = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id
        ).all()
        
        if not annotation_files:
            print("No annotation files found for this dataset")
            return
        
        for ann_file in annotation_files:
            print(f"\nAnnotation File: {ann_file.name} (ID: {ann_file.id})")
            print(f"  Total annotations: {ann_file.annotation_count}")
            
            # Get sample annotations
            annotations = db.query(Annotation).filter(
                Annotation.annotation_file_id == ann_file.id
            ).limit(limit).all()
            
            print(f"\n  Sample annotations (showing first {len(annotations)}):")
            
            for i, ann in enumerate(annotations, 1):
                image = db.query(Image).filter(Image.id == ann.image_id).first()
                print(f"\n  Annotation {i}:")
                print(f"    ID: {ann.id}")
                print(f"    Image: {image.file_name if image else 'N/A'} (ID: {ann.image_id})")
                print(f"    Category: {ann.category}")
                print(f"    Bbox: {ann.bbox}")
                print(f"    Has segmentation: {ann.segmentation is not None}")
                
                if ann.segmentation:
                    seg = ann.segmentation
                    print(f"    Segmentation type: {type(seg)}")
                    print(f"    Segmentation is list: {isinstance(seg, list)}")
                    
                    if isinstance(seg, list):
                        print(f"    Number of polygons: {len(seg)}")
                        if len(seg) > 0:
                            first_poly = seg[0]
                            print(f"    First polygon type: {type(first_poly)}")
                            print(f"    First polygon is list: {isinstance(first_poly, list)}")
                            if isinstance(first_poly, list):
                                print(f"    First polygon length: {len(first_poly)}")
                                print(f"    First polygon points (first 6 values): {first_poly[:6] if len(first_poly) >= 6 else first_poly}")
                                
                                # Check if values are reasonable (not too large)
                                max_val = max(abs(v) for v in first_poly) if first_poly else 0
                                print(f"    Max coordinate value: {max_val}")
                                
                                if image:
                                    print(f"    Image dimensions: {image.width}x{image.height}")
                                    if max_val > max(image.width or 1, image.height or 1) * 2:
                                        print(f"    ⚠️  WARNING: Coordinates seem too large for image size!")
                                    elif max_val <= 1:
                                        print(f"    ⚠️  WARNING: Coordinates seem normalized (<= 1), but should be pixel coordinates!")
                else:
                    print(f"    ⚠️  WARNING: No segmentation data!")
                
                print()
        
        # Check for images with annotations
        images_with_anns = db.query(Image).join(
            Annotation, Annotation.image_id == Image.id
        ).filter(
            Image.dataset_id == dataset_id
        ).distinct().limit(5).all()
        
        print(f"\n=== Images with annotations (sample of {len(images_with_anns)}) ===")
        for img in images_with_anns:
            ann_count = db.query(Annotation).filter(
                Annotation.image_id == img.id,
                Annotation.segmentation.isnot(None)  # Only count annotations with segmentation
            ).count()
            print(f"  {img.file_name}: {ann_count} annotations with segmentation")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python inspect_augmented_annotations.py <dataset_id> [limit]")
        print("Example: python inspect_augmented_annotations.py 49 10")
        sys.exit(1)
    
    dataset_id = int(sys.argv[1])
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    
    inspect_annotations(dataset_id, limit)
