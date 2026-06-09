#!/usr/bin/env python3
"""Check augmented dataset annotations to verify segmentation format."""

import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationFile

def check_annotations(dataset_id: int):
    db: Session = SessionLocal()
    
    try:
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            print(f"Dataset {dataset_id} not found")
            return
        
        print(f"Dataset: {dataset.name} (ID: {dataset_id})")
        print(f"Project ID: {dataset.project_id}")
        print()
        
        # Get annotation files
        annotation_files = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id
        ).all()
        
        if not annotation_files:
            print("No annotation files found")
            return
        
        for ann_file in annotation_files:
            print(f"Annotation File: {ann_file.name} (ID: {ann_file.id})")
            print(f"  Annotation count: {ann_file.annotation_count}")
            print()
            
            # Get a sample of images with annotations
            images = db.query(Image).join(
                Annotation, Annotation.image_id == Image.id
            ).filter(
                Image.dataset_id == dataset_id,
                Annotation.annotation_file_id == ann_file.id
            ).distinct().limit(5).all()
            
            print(f"Sample images with annotations ({len(images)}):")
            for img in images:
                annotations = db.query(Annotation).filter(
                    Annotation.image_id == img.id,
                    Annotation.annotation_file_id == ann_file.id
                ).all()
                
                print(f"\n  Image: {img.file_name} (ID: {img.id})")
                print(f"    Dimensions: {img.width}x{img.height}")
                print(f"    Annotations: {len(annotations)}")
                
                for i, ann in enumerate(annotations[:3]):  # Show first 3
                    print(f"      Annotation {i+1}:")
                    print(f"        Category: {ann.category}")
                    print(f"        Bbox: {ann.bbox}")
                    print(f"        Has segmentation: {ann.segmentation is not None}")
                    if ann.segmentation:
                        if isinstance(ann.segmentation, list):
                            print(f"        Segmentation type: list with {len(ann.segmentation)} polygon(s)")
                            if len(ann.segmentation) > 0:
                                first_poly = ann.segmentation[0]
                                if isinstance(first_poly, list):
                                    print(f"        First polygon: {len(first_poly)} values ({len(first_poly)//2} points)")
                                    if len(first_poly) >= 6:
                                        print(f"        First 6 values: {first_poly[:6]}")
                                        print(f"        Last 6 values: {first_poly[-6:]}")
                                    # Check if values are reasonable
                                    if len(first_poly) >= 2:
                                        max_val = max(abs(v) for v in first_poly[:10])  # Check first 10 values
                                        min_val = min(abs(v) for v in first_poly[:10])
                                        print(f"        Value range (first 10): min={min_val:.2f}, max={max_val:.2f}")
                                        if max_val > img.width * 2 or max_val > img.height * 2:
                                            print(f"        WARNING: Values seem too large for image size!")
                                        elif max_val <= 1.0:
                                            print(f"        WARNING: Values seem normalized (should be pixel coordinates)")
                                else:
                                    print(f"        First polygon is not a list: {type(first_poly)}")
                            else:
                                print(f"        Segmentation list is empty!")
                        else:
                            print(f"        Segmentation is not a list: {type(ann.segmentation)}")
                    else:
                        print(f"        No segmentation data")
                    print()
            
            # Count annotations with/without segmentation
            total_anns = db.query(Annotation).filter(
                Annotation.annotation_file_id == ann_file.id
            ).count()
            
            anns_with_seg = db.query(Annotation).filter(
                Annotation.annotation_file_id == ann_file.id,
                Annotation.segmentation.isnot(None)
            ).count()
            
            print(f"\nSummary for {ann_file.name}:")
            print(f"  Total annotations: {total_anns}")
            print(f"  With segmentation: {anns_with_seg}")
            print(f"  Without segmentation: {total_anns - anns_with_seg}")
            print()
    
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python check_augmented_annotations.py <dataset_id>")
        print("Example: python check_augmented_annotations.py 49")
        sys.exit(1)
    
    dataset_id = int(sys.argv[1])
    check_annotations(dataset_id)
