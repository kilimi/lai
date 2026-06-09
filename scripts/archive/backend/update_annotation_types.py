#!/usr/bin/env python3
"""
Script to update existing annotation_files type values from old format to new format.

Old values -> New values:
- 'segmentation' -> 'Segmentation (bbox)'  (default for old segmentation)
- 'classification' -> 'Classification'
- 'nothing' -> 'Other'

This script also re-analyzes the annotation content to determine the correct detailed type.
"""

import os
import sys
import asyncio
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
import json

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.services.annotation_processing import detect_annotation_type

async def update_annotation_types():
    """Update existing annotation type values to new format."""
    
    # Database connection
    database_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db/lai_db")
    engine = create_engine(database_url)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    
    print("Starting annotation type migration...")
    
    with SessionLocal() as db:
        # Get all annotation files that need updating
        result = db.execute(text("""
            SELECT id, name, type, format
            FROM annotation_files 
            WHERE type IN ('segmentation', 'classification', 'nothing') 
               OR type IS NULL
        """))
        
        annotation_files = result.fetchall()
        total_files = len(annotation_files)
        
        if total_files == 0:
            print("No annotation files need updating.")
            return
            
        print(f"Found {total_files} annotation files to update:")
        
        updated_count = 0
        
        for i, file_record in enumerate(annotation_files, 1):
            file_id, name, old_type, format_type = file_record
            
            print(f"[{i}/{total_files}] Processing: {name} (current type: {old_type})")
            
            try:
                new_type = None
                
                # Since we don't have file_path, we'll map old types to new types
                if old_type == 'classification':
                    new_type = 'Classification'
                elif old_type == 'segmentation':
                    new_type = 'Segmentation (bbox)'  # Default for old segmentation
                elif old_type == 'nothing' or old_type is None:
                    new_type = 'Other'
                else:
                    # Already a new type format, skip
                    print(f"  -> Skipping, already new format: {old_type}")
                    continue
                
                print(f"  -> Mapped {old_type} -> {new_type}")
                
                # Update the database
                db.execute(text("""
                    UPDATE annotation_files 
                    SET type = :new_type, updated_at = CURRENT_TIMESTAMP
                    WHERE id = :file_id
                """), {"new_type": new_type, "file_id": file_id})
                
                updated_count += 1
                
            except Exception as e:
                print(f"  -> Error updating {name}: {e}")
        
        # Commit all changes
        db.commit()
        
        print(f"\nMigration completed!")
        print(f"Updated {updated_count} out of {total_files} annotation files.")
        
        # Show summary of current types
        result = db.execute(text("""
            SELECT type, COUNT(*) as count 
            FROM annotation_files 
            GROUP BY type 
            ORDER BY count DESC
        """))
        
        print("\nCurrent type distribution:")
        for type_name, count in result.fetchall():
            print(f"  {type_name}: {count}")

if __name__ == "__main__":
    asyncio.run(update_annotation_types())
