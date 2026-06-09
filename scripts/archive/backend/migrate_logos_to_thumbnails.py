#!/usr/bin/env python3
"""
Migrate existing project logos to thumbnails for better performance.
This script converts full-size base64 images to optimized 200x200 thumbnails.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from app.database import SessionLocal
from app import models
from PIL import Image
import io
import base64
import re


def extract_image_data(data_url: str) -> tuple[bytes, str]:
    """Extract image bytes and mime type from data URL."""
    match = re.match(r'data:([^;]+);base64,(.+)', data_url)
    if not match:
        raise ValueError("Invalid data URL format")
    
    mime_type = match.group(1)
    base64_data = match.group(2)
    image_data = base64.b64decode(base64_data)
    
    return image_data, mime_type


def create_thumbnail(image_data: bytes, max_size: tuple = (200, 200)) -> str:
    """Create a thumbnail from image data and return base64 encoded string."""
    try:
        # Open image from bytes
        img = Image.open(io.BytesIO(image_data))
        
        # Convert RGBA to RGB if necessary
        if img.mode == 'RGBA':
            background = Image.new('RGB', img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])  # 3 is the alpha channel
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Get original size for comparison
        original_size = len(image_data)
        
        # Create thumbnail maintaining aspect ratio
        img.thumbnail(max_size, Image.Resampling.LANCZOS)
        
        # Save to bytes
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=85, optimize=True)
        thumbnail_data = buffer.getvalue()
        
        # Encode to base64
        thumbnail_base64 = base64.b64encode(thumbnail_data).decode()
        thumbnail_url = f"data:image/jpeg;base64,{thumbnail_base64}"
        
        new_size = len(thumbnail_data)
        reduction = ((original_size - new_size) / original_size) * 100
        
        return thumbnail_url, original_size, new_size, reduction
    except Exception as e:
        raise Exception(f"Error creating thumbnail: {e}")


def migrate_project_logos():
    """Migrate all project logos to thumbnails."""
    db = SessionLocal()
    try:
        projects = db.query(models.Project).all()
        
        print(f"Found {len(projects)} projects")
        
        updated_count = 0
        skipped_count = 0
        error_count = 0
        total_original_size = 0
        total_new_size = 0
        
        for project in projects:
            if not project.logo_url:
                print(f"  Skipping project {project.id} '{project.name}': No logo")
                skipped_count += 1
                continue
            
            if not project.logo_url.startswith("data:image/"):
                print(f"  Skipping project {project.id} '{project.name}': Not a base64 image")
                skipped_count += 1
                continue
            
            try:
                # Extract image data from current logo_url
                image_data, mime_type = extract_image_data(project.logo_url)
                
                # Create thumbnail
                thumbnail_url, original_size, new_size, reduction = create_thumbnail(image_data)
                
                # Update project
                project.logo_url = thumbnail_url
                
                total_original_size += original_size
                total_new_size += new_size
                updated_count += 1
                
                print(f"  ✓ Updated project {project.id} '{project.name}':")
                print(f"    Original: {original_size / 1024:.1f} KB → Thumbnail: {new_size / 1024:.1f} KB ({reduction:.1f}% reduction)")
                
            except Exception as e:
                print(f"  ✗ Error processing project {project.id} '{project.name}': {e}")
                error_count += 1
                continue
        
        # Commit all changes
        db.commit()
        
        print("\n" + "="*60)
        print("Migration Summary:")
        print(f"  Total projects: {len(projects)}")
        print(f"  Updated: {updated_count}")
        print(f"  Skipped: {skipped_count}")
        print(f"  Errors: {error_count}")
        
        if updated_count > 0:
            print(f"\nSize Reduction:")
            print(f"  Original total: {total_original_size / 1024:.1f} KB")
            print(f"  New total: {total_new_size / 1024:.1f} KB")
            print(f"  Savings: {(total_original_size - total_new_size) / 1024:.1f} KB ({((total_original_size - total_new_size) / total_original_size) * 100:.1f}%)")
        
        print("="*60)
        
    except Exception as e:
        db.rollback()
        print(f"Migration failed: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    print("Starting logo to thumbnail migration...")
    migrate_project_logos()
    print("Migration complete!")
