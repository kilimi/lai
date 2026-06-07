#!/usr/bin/env python3
"""
Quick fix for the "relation already exists" Alembic error.
This script handles the specific case where tables exist but Alembic thinks they don't.
"""

import sys
from pathlib import Path

# Add the app directory to Python path
sys.path.append('.')

from app.database import engine, SessionLocal
from sqlalchemy import text, inspect

def fix_alembic_state():
    """Fix Alembic state when tables exist but version tracking is broken."""
    print("LAI - Alembic State Fix")
    print("=" * 50)
    
    db = SessionLocal()
    try:
        inspector = inspect(engine)
        existing_tables = inspector.get_table_names()
        
        print(f"Found {len(existing_tables)} existing tables:")
        for table in existing_tables:
            print(f"  - {table}")
        
        if not existing_tables:
            print("No tables found. Run 'alembic upgrade head' to create them.")
            return
        
        # Check if alembic_version exists
        if 'alembic_version' in existing_tables:
            # Get current version
            result = db.execute(text("SELECT version_num FROM alembic_version")).fetchone()
            if result:
                print(f"\nCurrent Alembic version: {result[0]}")
                print("Alembic tracking seems to be working.")
                return
            else:
                print("\nAlembic version table exists but is empty.")
        else:
            print("\nAlembic version table does not exist.")
        
        print("\nThis suggests the tables were created directly (not via Alembic).")
        print("Let's fix this by marking the database as up-to-date with Alembic.")
        
        response = input("\nDo you want to mark the database as migrated? (yes/no): ")
        if response.lower() != 'yes':
            print("Fix cancelled.")
            return
        
        # Create alembic_version table if it doesn't exist
        if 'alembic_version' not in existing_tables:
            db.execute(text("""
                CREATE TABLE alembic_version (
                    version_num VARCHAR(32) NOT NULL PRIMARY KEY
                )
            """))
            print("Created alembic_version table.")
        
        # Mark as migrated to the latest version
        # First, clear any existing version
        db.execute(text("DELETE FROM alembic_version"))
        
        # Insert the latest migration version
        # You should check your migrations/versions/ folder for the latest version
        db.execute(text("INSERT INTO alembic_version (version_num) VALUES ('a21817509ba3')"))
        
        db.commit()
        
        print("✅ Fixed Alembic state!")
        print("\nNow you can:")
        print("1. Run 'alembic current' to verify the state")
        print("2. Run 'alembic upgrade head' if there are newer migrations")
        print("3. Start using the application normally")
        
    except Exception as e:
        print(f"❌ Fix failed: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    # Check if we're in the right directory
    if not Path("app").exists():
        print("❌ Error: This script must be run from the backend directory.")
        print("Current directory:", Path.cwd())
        sys.exit(1)
    
    fix_alembic_state()
