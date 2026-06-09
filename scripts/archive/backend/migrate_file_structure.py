#!/usr/bin/env python3
"""
Migration script to move files from old structure to new structure.
Old: data/images/{dataset_id}/
New: projects/{project_id}/{dataset_id}/images/

Run this script from the backend directory:
python migrate_file_structure.py
"""

import os
import shutil
from pathlib import Path
import sys

# Add the app directory to Python path
sys.path.append('.')

from app.database import SessionLocal
from app import models

def migrate_file_structure():
    """Migrate files from old structure to new structure."""
    db = SessionLocal()
    
    try:
        print("Starting file structure migration...")
        
        # Get all datasets with their project information
        datasets = db.query(models.Dataset).all()
        
        if not datasets:
            print("No datasets found.")
            return
        
        print(f"Found {len(datasets)} datasets to process.")
        
        migrated_count = 0
        skipped_count = 0
        error_count = 0
        
        for dataset in datasets:
            try:
                print(f"\nProcessing dataset {dataset.id} ('{dataset.name}') in project {dataset.project_id}...")
                
                # Define old and new paths
                old_dataset_dir = Path("data") / "images" / str(dataset.id)
                new_dataset_dir = Path("projects") / str(dataset.project_id) / str(dataset.id) / "images"
                
                # Check if old directory exists
                if not old_dataset_dir.exists():
                    print(f"  Old directory not found: {old_dataset_dir}")
                    skipped_count += 1
                    continue
                
                # Check if new directory already exists and has files
                if new_dataset_dir.exists() and any(new_dataset_dir.iterdir()):
                    print(f"  New directory already exists with files: {new_dataset_dir}")
                    skipped_count += 1
                    continue
                
                # Create new directory structure
                new_dataset_dir.mkdir(parents=True, exist_ok=True)
                
                # Get all image files in old directory
                image_files = list(old_dataset_dir.glob("*"))
                
                if not image_files:
                    print(f"  No files found in {old_dataset_dir}")
                    skipped_count += 1
                    continue
                
                print(f"  Found {len(image_files)} files to migrate")
                
                # Copy files to new location
                copied_files = 0
                for file_path in image_files:
                    if file_path.is_file():
                        try:
                            new_file_path = new_dataset_dir / file_path.name
                            shutil.copy2(file_path, new_file_path)
                            copied_files += 1
                            print(f"    Copied: {file_path.name}")
                        except Exception as e:
                            print(f"    Error copying {file_path.name}: {e}")
                            error_count += 1
                
                if copied_files > 0:
                    print(f"  Successfully copied {copied_files} files")
                    migrated_count += 1
                    
                    # Optionally remove old directory (commented out for safety)
                    # print(f"  Removing old directory: {old_dataset_dir}")
                    # shutil.rmtree(old_dataset_dir)
                    print(f"  Note: Old directory kept for safety: {old_dataset_dir}")
                else:
                    print(f"  No files were copied")
                    
            except Exception as e:
                print(f"  Error processing dataset {dataset.id}: {e}")
                error_count += 1
                continue
        
        print(f"\n=== Migration Summary ===")
        print(f"Datasets migrated: {migrated_count}")
        print(f"Datasets skipped: {skipped_count}")
        print(f"Errors encountered: {error_count}")
        
        if migrated_count > 0:
            print("\nMigration completed successfully!")
            print("Note: Old directories are kept for safety. You can manually remove them after verifying the migration.")
        else:
            print("\nNo datasets were migrated.")
            
    except Exception as e:
        print(f"Migration failed with error: {e}")
        
    finally:
        db.close()

def update_image_urls():
    """Update image URLs in database to use new path structure."""
    db = SessionLocal()
    
    try:
        print("\nUpdating image URLs in database...")
        
        # Get all images that still use the old URL format
        images = db.query(models.Image).filter(
            models.Image.url.like('/data/images/%')
        ).all()
        
        if not images:
            print("No images with old URLs found.")
            return
        
        print(f"Found {len(images)} images with old URLs to update.")
        
        updated_count = 0
        
        for image in images:
            try:
                # Get the dataset to find project_id
                dataset = db.query(models.Dataset).filter(
                    models.Dataset.id == image.dataset_id
                ).first()
                
                if not dataset:
                    print(f"  Warning: Dataset not found for image {image.id}")
                    continue
                
                # Update URL from /data/images/{dataset_id}/{filename} 
                # to /projects/{project_id}/{dataset_id}/images/{filename}
                old_url = image.url
                new_url = f"/projects/{dataset.project_id}/{image.dataset_id}/images/{image.file_name}"
                
                image.url = new_url
                image.thumbnail_url = new_url
                
                print(f"  Updated image {image.id}: {old_url} -> {new_url}")
                updated_count += 1
                
            except Exception as e:
                print(f"  Error updating image {image.id}: {e}")
                continue
        
        if updated_count > 0:
            db.commit()
            print(f"\nSuccessfully updated {updated_count} image URLs.")
        else:
            print("\nNo image URLs were updated.")
            
    except Exception as e:
        print(f"URL update failed with error: {e}")
        db.rollback()
        
    finally:
        db.close()

if __name__ == "__main__":
    print("LAI - File Structure Migration")
    print("=" * 50)
    
    # Check if we're in the right directory
    if not Path("app").exists():
        print("Error: This script must be run from the backend directory.")
        print("Current directory:", os.getcwd())
        sys.exit(1)
    
    response = input("Do you want to migrate file structure from data/images/ to projects/? (y/N): ")
    if response.lower() in ['y', 'yes']:
        migrate_file_structure()
        
        response2 = input("\nDo you want to update image URLs in the database? (y/N): ")
        if response2.lower() in ['y', 'yes']:
            update_image_urls()
        else:
            print("Skipped URL updates. You may need to run this later.")
    else:
        print("Migration cancelled.")
