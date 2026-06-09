#!/usr/bin/env python3
"""Find images with annotations."""

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Dataset, Image, Annotation, AnnotationFile

db = SessionLocal()

dataset_id = 22
annotation_file = db.query(AnnotationFile).filter(
    AnnotationFile.dataset_id == dataset_id
).first()

if not annotation_file:
    print("No annotation file found")
    exit(1)

print(f"Annotation file ID: {annotation_file.id}")

# Find images with annotations
images_with_annotations = db.query(Image).join(
    Annotation, Annotation.image_id == Image.id
).filter(
    Image.dataset_id == dataset_id,
    Annotation.annotation_file_id == annotation_file.id
).distinct().limit(5).all()

print(f"\nFound {len(images_with_annotations)} images with annotations:")
for img in images_with_annotations:
    ann_count = db.query(Annotation).filter(
        Annotation.image_id == img.id,
        Annotation.annotation_file_id == annotation_file.id
    ).count()
    print(f"  {img.file_name}: {ann_count} annotations (ID: {img.id})")

db.close()
