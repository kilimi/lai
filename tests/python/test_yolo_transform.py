#!/usr/bin/env python3
"""
Test script to verify database annotation transformation to YOLO segmentation format.

Skipped in default pytest runs — requires live Postgres and an existing dataset.
Set LAI_INTEGRATION_TESTS=1 and point DATABASE_URL at your stack.
"""

import sys

import pytest

from conftest import requires_integration_stack

pytestmark = [pytest.mark.integration, requires_integration_stack]
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationClass, AnnotationFile
import json

def test_annotation_transform(dataset_id: int = 22):
    """Test transforming annotations from database to YOLO format."""
    db = SessionLocal()
    
    try:
        # Get dataset
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            print(f"❌ Dataset {dataset_id} not found")
            return
        
        print(f"✓ Found dataset: {dataset.name} (ID: {dataset_id})")
        
        # Get annotation file
        annotation_file = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id
        ).first()
        
        if not annotation_file:
            print(f"❌ No annotation file found for dataset {dataset_id}")
            return
        
        print(f"✓ Found annotation file (ID: {annotation_file.id})")
        
        # Get a sample image with annotations
        images = db.query(Image).join(
            Annotation, Annotation.image_id == Image.id
        ).filter(
            Image.dataset_id == dataset_id,
            Annotation.annotation_file_id == annotation_file.id
        ).distinct().limit(3).all()
        
        print(f"✓ Found {len(images)} sample images")
        
        for img in images:
            print(f"\n{'='*80}")
            print(f"Image: {img.file_name}")
            print(f"  Dimensions: {img.width}x{img.height}")
            
            # Get annotations for this image
            annotations = db.query(Annotation).filter(
                Annotation.image_id == img.id,
                Annotation.annotation_file_id == annotation_file.id
            ).all()
            
            print(f"  Annotations: {len(annotations)}")
            
            if not annotations:
                print("  ⚠ No annotations found")
                continue
            
            # Process each annotation
            yolo_labels = []
            for i, ann in enumerate(annotations):
                print(f"\n  Annotation {i+1}:")
                
                # Get class info
                ann_class = db.query(AnnotationClass).filter(
                    AnnotationClass.annotation_file_id == annotation_file.id,
                    AnnotationClass.category_id == ann.category_id
                ).first()
                
                if not ann_class:
                    print(f"    ❌ No class found for category_id {ann.category_id}")
                    continue
                
                print(f"    Class: {ann_class.class_name} (ID: {ann.category_id})")
                
                # Check segmentation data
                if ann.segmentation:
                    seg = ann.segmentation
                    print(f"    Segmentation type: {type(seg)}")
                    
                    if isinstance(seg, str):
                        try:
                            seg = json.loads(seg)
                        except:
                            print(f"    ❌ Failed to parse segmentation JSON")
                            continue
                    
                    if isinstance(seg, list) and len(seg) > 0:
                        # Get polygon
                        if isinstance(seg[0], list):
                            polygon = seg[0]
                        else:
                            polygon = seg
                        
                        print(f"    Polygon points: {len(polygon)//2}")
                        print(f"    First 10 coords: {polygon[:10]}")
                        
                        if len(polygon) < 6:
                            print(f"    ❌ Polygon too short (need at least 6 coords)")
                            continue
                        
                        # Check if normalized or pixel
                        needs_normalization = any(abs(val) > 2 for val in polygon)
                        print(f"    Needs normalization: {needs_normalization}")
                        
                        # Normalize if needed
                        normalized_coords = []
                        if needs_normalization:
                            for j in range(0, len(polygon), 2):
                                if j + 1 < len(polygon):
                                    norm_x = polygon[j] / img.width
                                    norm_y = polygon[j + 1] / img.height
                                    normalized_coords.extend([norm_x, norm_y])
                        else:
                            normalized_coords = polygon
                        
                        # Create YOLO label
                        class_id = 0  # For testing, use 0
                        coords_str = ' '.join(f"{c:.6f}" for c in normalized_coords)
                        yolo_label = f"{class_id} {coords_str}"
                        yolo_labels.append(yolo_label)
                        
                        print(f"    ✓ YOLO label length: {len(yolo_label)} chars")
                        print(f"    ✓ YOLO label (first 100 chars): {yolo_label[:100]}...")
                        
                        # Verify all coordinates are in 0-1 range
                        out_of_range = [c for c in normalized_coords if c < 0 or c > 1]
                        if out_of_range:
                            print(f"    ⚠ Warning: {len(out_of_range)} coords out of range [0,1]")
                            print(f"      Examples: {out_of_range[:5]}")
                    else:
                        print(f"    ❌ Segmentation is not a valid polygon list")
                
                elif ann.bbox:
                    print(f"    ⚠ Has bbox but no segmentation")
                    bbox = ann.bbox
                    if isinstance(bbox, str):
                        bbox = json.loads(bbox)
                    print(f"    Bbox: {bbox}")
                else:
                    print(f"    ❌ No segmentation or bbox data")
            
            # Show final YOLO labels for this image
            if yolo_labels:
                print(f"\n  Final YOLO labels ({len(yolo_labels)} objects):")
                for j, label in enumerate(yolo_labels[:3]):  # Show first 3
                    print(f"    Label {j+1}: {label[:80]}...")
                
                # Simulate writing to file
                label_content = '\n'.join(yolo_labels)
                print(f"\n  ✓ Label file would have {len(label_content)} chars, {len(yolo_labels)} lines")
            else:
                print(f"\n  ❌ No valid YOLO labels generated")
    
    finally:
        db.close()


if __name__ == "__main__":
    dataset_id = int(sys.argv[1]) if len(sys.argv) > 1 else 22
    print(f"Testing YOLO transformation for dataset {dataset_id}\n")
    test_annotation_transform(dataset_id)
