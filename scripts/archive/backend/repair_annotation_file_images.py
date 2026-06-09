#!/usr/bin/env python3
"""
Repair script to populate missing AnnotationFileImage entries for existing annotation files.
This script reads the content of existing annotation files and creates the missing entries.
"""

import sys
import json
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import AnnotationFile, AnnotationFileImage, Image

def repair_annotation_file_images():
    """Populate missing AnnotationFileImage entries for existing annotation files."""
    db = SessionLocal()
    try:
        # Get all annotation files that don't have AnnotationFileImage entries
        annotation_files = db.query(AnnotationFile).all()
        
        for af in annotation_files:
            print(f"Processing annotation file: {af.name} (ID: {af.id})")
            
            # Check if this file already has AnnotationFileImage entries
            existing_count = db.query(AnnotationFileImage).filter(
                AnnotationFileImage.annotation_file_id == af.id
            ).count()
            
            if existing_count > 0:
                print(f"  Already has {existing_count} entries, skipping...")
                continue
            
            # Get dataset images for mapping - prioritize default collection
            from app.models import ImageCollection
            
            # First, try to get images from the default collection
            default_collection = db.query(ImageCollection).filter(
                ImageCollection.dataset_id == af.dataset_id,
                ImageCollection.is_default == True
            ).first()
            
            if default_collection:
                print(f"  Using default collection '{default_collection.name}' for coverage tracking")
                dataset_images = db.query(Image).filter(
                    Image.dataset_id == af.dataset_id,
                    Image.collection_id == default_collection.id
                ).all()
            else:
                # If no default collection, get the first collection or all images
                first_collection = db.query(ImageCollection).filter(
                    ImageCollection.dataset_id == af.dataset_id
                ).first()
                
                if first_collection:
                    print(f"  No default collection found, using first collection '{first_collection.name}' for coverage tracking")
                    dataset_images = db.query(Image).filter(
                        Image.dataset_id == af.dataset_id,
                        Image.collection_id == first_collection.id
                    ).all()
                else:
                    # Fallback: use all images (for datasets without collections)
                    print(f"  No collections found, using all images for coverage tracking")
                    dataset_images = db.query(Image).filter(Image.dataset_id == af.dataset_id).all()
            
            image_mapping = {}
            for img in dataset_images:
                image_mapping[img.file_name] = img.id
                # Also try without extension
                base_name = img.file_name.rsplit('.', 1)[0] if '.' in img.file_name else img.file_name
                image_mapping[base_name] = img.id
            
            # Try to get content from the annotation file
            # Note: We'll create entries based on annotations in the database since we don't have the original file
            from app.models import Annotation
            annotations = db.query(Annotation).filter(Annotation.annotation_file_id == af.id).all()
            
            # Get unique COCO image IDs from annotations
            coco_image_info = {}
            for ann in annotations:
                if ann.coco_image_id not in coco_image_info:
                    coco_image_info[ann.coco_image_id] = {
                        'dataset_image_id': ann.image_id,
                        'file_name': None  # We don't have the original filename
                    }
            
            print(f"  Found {len(coco_image_info)} unique images in annotations")
            
            # Create AnnotationFileImage entries
            for coco_image_id, info in coco_image_info.items():
                try:
                    # Get the actual image to get the filename
                    img = db.query(Image).filter(Image.id == info['dataset_image_id']).first()
                    file_name = img.file_name if img else f"unknown_{coco_image_id}"
                    
                    afi = AnnotationFileImage(
                        annotation_file_id=af.id,
                        coco_image_id=coco_image_id,
                        file_name=file_name,
                        dataset_image_id=info['dataset_image_id'],
                        width=img.width if img else None,
                        height=img.height if img else None
                    )
                    db.add(afi)
                    print(f"    Created entry for image: {file_name}")
                except Exception as e:
                    print(f"    ERROR creating entry for coco_image_id {coco_image_id}: {e}")
            
            db.commit()
            print(f"  Created {len(coco_image_info)} AnnotationFileImage entries")
        
        print("Repair completed successfully!")
        
    except Exception as e:
        print(f"Error during repair: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    repair_annotation_file_images()
