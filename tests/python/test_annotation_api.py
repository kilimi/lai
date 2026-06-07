#!/usr/bin/env python3
"""
Test script to verify annotation data format and check why annotations aren't showing.
"""
import sys
import json

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationFile

def test_annotation_data(dataset_id: int):
    """Test annotation data format."""
    db: Session = SessionLocal()
    
    try:
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            print(f"Dataset {dataset_id} not found")
            return
        
        print(f"\n=== Testing Annotation Data for Dataset: {dataset.name} (ID: {dataset_id}) ===\n")
        
        # Get annotation files
        annotation_files = db.query(AnnotationFile).filter(
            AnnotationFile.dataset_id == dataset_id
        ).all()
        
        if not annotation_files:
            print("No annotation files found")
            return
        
        for ann_file in annotation_files:
            print(f"\n{'='*80}")
            print(f"Annotation File: {ann_file.name} (ID: {ann_file.id})")
            print(f"{'='*80}\n")
            
            # Get sample annotations
            annotations = db.query(Annotation).filter(
                Annotation.annotation_file_id == ann_file.id
            ).limit(5).all()
            
            print(f"Found {len(annotations)} sample annotations:\n")
            
            for i, ann in enumerate(annotations, 1):
                image = db.query(Image).filter(Image.id == ann.image_id).first()
                print(f"Annotation {i}:")
                print(f"  ID: {ann.id}")
                print(f"  Image: {image.file_name if image else 'N/A'} (ID: {ann.image_id})")
                print(f"  Category: {ann.category}")
                print(f"  Bbox: {ann.bbox}")
                print(f"  Has segmentation: {ann.segmentation is not None}")
                
                if ann.segmentation:
                    seg = ann.segmentation
                    print(f"  Segmentation type: {type(seg)}")
                    if isinstance(seg, list):
                        print(f"  Number of polygons: {len(seg)}")
                        if len(seg) > 0:
                            first_poly = seg[0]
                            print(f"  First polygon type: {type(first_poly)}")
                            print(f"  First polygon length: {len(first_poly)} values ({len(first_poly)//2} points)")
                            
                            if len(first_poly) >= 2:
                                print(f"  First point: ({first_poly[0]}, {first_poly[1]})")
                                
                                # Check for issues
                                negative_count = sum(1 for v in first_poly if v < 0)
                                if negative_count > 0:
                                    print(f"  ⚠️  WARNING: {negative_count} negative values!")
                                
                                if image:
                                    max_val = max(abs(v) for v in first_poly) if first_poly else 0
                                    if max_val > max(image.width or 1, image.height or 1) * 1.5:
                                        print(f"  ⚠️  WARNING: Coordinates seem too large (max: {max_val}, image: {image.width}x{image.height})")
                                    elif max_val <= 1:
                                        print(f"  ⚠️  WARNING: Coordinates seem normalized (max: {max_val})")
                                    else:
                                        print(f"  ✓ Coordinates look valid (max: {max_val}, image: {image.width}x{image.height})")
                
                print()
            
            # Check if images have annotations
            print(f"\nChecking image-annotation mapping:")
            images_with_anns = db.query(Image).join(
                Annotation, Annotation.image_id == Image.id
            ).filter(
                Image.dataset_id == dataset_id,
                Annotation.annotation_file_id == ann_file.id
            ).distinct().limit(5).all()
            
            print(f"  Found {len(images_with_anns)} images with annotations")
            for img in images_with_anns:
                ann_count = db.query(Annotation).filter(
                    Annotation.image_id == img.id,
                    Annotation.annotation_file_id == ann_file.id,
                    Annotation.segmentation.isnot(None)
                ).count()
                print(f"    {img.file_name}: {ann_count} annotations with segmentation")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: pytest tests/python/test_annotation_api.py -- <dataset_id>")
        print("   or: python tests/python/test_annotation_api.py <dataset_id>")
        sys.exit(1)
    
    dataset_id = int(sys.argv[1])
    test_annotation_data(dataset_id)
