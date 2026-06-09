#!/usr/bin/env python3
"""
Add database indexes to optimize merge operations
"""

from sqlalchemy import create_engine, text
import os
from app.database import SQLALCHEMY_DATABASE_URL

def add_merge_indexes():
    """Add indexes specifically for merge operations performance"""
    engine = create_engine(SQLALCHEMY_DATABASE_URL)
    
    indexes = [
        # Composite index for annotation queries in merge
        "CREATE INDEX IF NOT EXISTS idx_annotations_merge ON annotations (annotation_file_id, image_id, category)",
        
        # Index for duplicate detection
        "CREATE INDEX IF NOT EXISTS idx_annotations_duplicate ON annotations (image_id, category_id, bbox_x, bbox_y, bbox_width, bbox_height)",
        
        # Composite index for batch queries
        "CREATE INDEX IF NOT EXISTS idx_annotations_batch ON annotations (annotation_file_id, dataset_id)",
        
        # Index for annotation file queries
        "CREATE INDEX IF NOT EXISTS idx_annotation_files_dataset ON annotation_files (dataset_id, is_processed)",
        
        # Index for image lookups
        "CREATE INDEX IF NOT EXISTS idx_images_dataset ON images (dataset_id, file_name)",
        
        # Index for class queries
        "CREATE INDEX IF NOT EXISTS idx_annotation_classes_file ON annotation_classes (annotation_file_id, class_name)",
        
        # Index for task queries
        "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, created_at)",
        
        # Partial index for active tasks
        "CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks (progress, status) WHERE status IN ('pending', 'running')"
    ]
    
    with engine.connect() as conn:
        for index_sql in indexes:
            try:
                print(f"Creating index: {index_sql}")
                conn.execute(text(index_sql))
                conn.commit()
                print("✓ Index created successfully")
            except Exception as e:
                print(f"✗ Error creating index: {e}")
                # Continue with other indexes
                continue

if __name__ == "__main__":
    print("Adding database indexes for merge optimization...")
    add_merge_indexes()
    print("Index optimization complete!")
