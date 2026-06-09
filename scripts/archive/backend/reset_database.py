#!/usr/bin/env python3
"""
Database Reset Script for LAI
This script will clear the entire database and recreate all tables fresh.
"""

import os
import sys
from pathlib import Path

# Add the app directory to Python path
sys.path.append('.')

from app.database import engine, SessionLocal, SQLALCHEMY_DATABASE_URL
from app import models
from sqlalchemy import text, inspect
import shutil

def clear_file_storage():
    """Remove all uploaded files from storage directories."""
    print("Clearing file storage...")
    
    storage_dirs = ["data", "projects"]
    
    for storage_dir in storage_dirs:
        storage_path = Path(storage_dir)
        if storage_path.exists():
            try:
                shutil.rmtree(storage_path)
                print(f"  Removed directory: {storage_path}")
            except Exception as e:
                print(f"  Error removing {storage_path}: {e}")
    
    # Recreate empty directories
    for storage_dir in storage_dirs:
        storage_path = Path(storage_dir)
        storage_path.mkdir(exist_ok=True)
        print(f"  Created directory: {storage_path}")

def clear_database_tables_only():
    """Drop all tables but don't recreate them (for use with Alembic)."""
    print("Dropping database tables...")
    
    db = SessionLocal()
    try:
        # Get inspector to check existing tables
        inspector = inspect(engine)
        existing_tables = inspector.get_table_names()
        
        if existing_tables:
            print(f"  Found {len(existing_tables)} existing tables: {existing_tables}")
            
            # Drop all tables in reverse order to handle foreign key constraints
            print("  Dropping all tables...")
            models.Base.metadata.drop_all(bind=engine)
            print("  All tables dropped successfully")
            print("  Note: Tables will be recreated by Alembic migrations")
        else:
            print("  No existing tables found")
        
    except Exception as e:
        print(f"  Error during database reset: {e}")
        raise
    finally:
        db.close()

def clear_database_tables():
    """Drop all tables and recreate them (for standalone use)."""
    print("Clearing database tables...")
    
    db = SessionLocal()
    try:
        # Get inspector to check existing tables
        inspector = inspect(engine)
        existing_tables = inspector.get_table_names()
        
        if existing_tables:
            print(f"  Found {len(existing_tables)} existing tables: {existing_tables}")
            
            # Drop all tables in reverse order to handle foreign key constraints
            print("  Dropping all tables...")
            models.Base.metadata.drop_all(bind=engine)
            print("  All tables dropped successfully")
        else:
            print("  No existing tables found")
        
        # Recreate all tables
        print("  Creating all tables...")
        models.Base.metadata.create_all(bind=engine)
        print("  All tables created successfully")
        
    except Exception as e:
        print(f"  Error during database reset: {e}")
        raise
    finally:
        db.close()

def clear_alembic_version():
    """Clear the alembic version table to reset migration tracking."""
    print("Clearing Alembic version history...")
    
    db = SessionLocal()
    try:
        # Check if alembic_version table exists
        inspector = inspect(engine)
        table_names = inspector.get_table_names()
        
        if 'alembic_version' in table_names:
            db.execute(text("DROP TABLE alembic_version"))
            db.commit()
            print("  Alembic version table cleared")
        else:
            print("  No alembic version table found")
            
    except Exception as e:
        print(f"  Error clearing alembic version: {e}")
    finally:
        db.close()

def reset_database_full():
    """Complete database reset - tables and files."""
    print("=" * 60)
    print("AI Data Creator - Complete Database Reset")
    print("=" * 60)
    
    print(f"Database URL: {SQLALCHEMY_DATABASE_URL}")
    
    # Confirm the action
    response = input("\n⚠️  This will DELETE ALL DATA. Are you sure? (yes/no): ")
    if response.lower() != 'yes':
        print("Reset cancelled.")
        return
    
    try:
        # Step 1: Clear file storage
        clear_file_storage()
        print()
        
        # Step 2: Clear database tables (but don't recreate them)
        clear_database_tables_only()
        print()
        
        # Step 3: Clear alembic version
        clear_alembic_version()
        print()
        
        print("✅ Database reset completed successfully!")
        print("\nNext steps:")
        print("1. Run migrations: alembic upgrade head")
        print("2. Start the backend server")
        print("3. Create new projects and datasets")
        
    except Exception as e:
        print(f"\n❌ Reset failed: {e}")
        sys.exit(1)

def reset_database_keep_schema():
    """Reset data but keep the schema (faster for development)."""
    print("=" * 60)
    print("AI Data Creator - Data-Only Reset")
    print("=" * 60)
    
    # Confirm the action
    response = input("\n⚠️  This will DELETE ALL DATA but keep schema. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Reset cancelled.")
        return
    
    db = SessionLocal()
    try:
        # Clear file storage
        clear_file_storage()
        print()
        
        # Clear data from all tables in the correct order (respecting foreign keys)
        print("Clearing table data...")
        
        # Order matters due to foreign key constraints
        tables_to_clear = [
            'augmentations',
            'annotations', 
            'images',
            'tasks',
            'datasets',
            'projects'
        ]
        
        for table_name in tables_to_clear:
            try:
                result = db.execute(text(f"DELETE FROM {table_name}"))
                print(f"  Cleared {result.rowcount} rows from {table_name}")
            except Exception as e:
                print(f"  Warning: Could not clear {table_name}: {e}")
        
        db.commit()
        print("\n✅ Data reset completed successfully!")
        print("Schema preserved - no need to run migrations.")
        
    except Exception as e:
        print(f"\n❌ Reset failed: {e}")
        db.rollback()
        sys.exit(1)
    finally:
        db.close()

def reset_for_fresh_alembic():
    """Reset everything and prepare for fresh Alembic migrations."""
    print("=" * 60)
    print("AI Data Creator - Fresh Alembic Reset")
    print("=" * 60)
    
    print("This will:")
    print("- Clear all data and files")
    print("- Drop all database tables")
    print("- Reset Alembic migration tracking")
    print("- Prepare for fresh migrations")
    
    # Confirm the action
    response = input("\n⚠️  This will DELETE ALL DATA. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Reset cancelled.")
        return
    
    try:
        # Step 1: Clear file storage
        clear_file_storage()
        print()
        
        # Step 2: Drop all tables (including alembic_version)
        print("Dropping all database tables...")
        db = SessionLocal()
        try:
            # Drop all tables including alembic_version
            inspector = inspect(engine)
            existing_tables = inspector.get_table_names()
            
            if existing_tables:
                print(f"  Found {len(existing_tables)} tables to drop")
                
                # Drop alembic_version first if it exists
                if 'alembic_version' in existing_tables:
                    db.execute(text("DROP TABLE alembic_version"))
                    print("  Dropped alembic_version table")
                
                # Drop all other tables
                models.Base.metadata.drop_all(bind=engine)
                print("  Dropped all application tables")
                
                db.commit()
            else:
                print("  No tables found to drop")
                
        finally:
            db.close()
        
        print()
        print("✅ Complete reset successful!")
        print("\nNext steps:")
        print("1. Run: alembic upgrade head")
        print("2. Start the backend server")
        print("3. Everything should work normally")
        
    except Exception as e:
        print(f"\n❌ Reset failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    print("AI Data Creator - Database Reset Utility")
    print()
    
    # Check if we're in the right directory
    if not Path("app").exists():
        print("❌ Error: This script must be run from the backend directory.")
        print("Current directory:", os.getcwd())
        sys.exit(1)
    
    print("Choose reset type:")
    print("1. Complete reset (drop tables + clear files) - Use with Alembic")
    print("2. Data-only reset (keep schema + clear data)")
    print("3. Fresh Alembic reset (recommended for your error)")
    print("4. Cancel")
    
    choice = input("\nEnter choice (1-4): ").strip()
    
    if choice == "1":
        reset_database_full()
    elif choice == "2":
        reset_database_keep_schema()
    elif choice == "3":
        reset_for_fresh_alembic()
    else:
        print("Reset cancelled.")
