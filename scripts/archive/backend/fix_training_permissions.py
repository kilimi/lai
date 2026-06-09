#!/usr/bin/env python3
"""
Script to fix permissions on training directories.
Run this if you encounter permission errors during training.
"""
import os
import sys
from pathlib import Path

def fix_permissions(directory: Path, recursive: bool = True):
    """Fix permissions on a directory and optionally its contents"""
    if not directory.exists():
        print(f"Directory {directory} does not exist")
        return
    
    try:
        # Fix directory permissions
        os.chmod(directory, 0o777)
        print(f"Fixed permissions on {directory}")
        
        if recursive:
            # Fix all files and subdirectories
            for root, dirs, files in os.walk(directory):
                for d in dirs:
                    dir_path = Path(root) / d
                    os.chmod(dir_path, 0o777)
                for f in files:
                    file_path = Path(root) / f
                    os.chmod(file_path, 0o666)
            print(f"Fixed permissions recursively on {directory}")
    except Exception as e:
        print(f"Error fixing permissions on {directory}: {e}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        # Fix specific directory
        target_dir = Path(sys.argv[1])
        fix_permissions(target_dir)
    else:
        # Fix all training directories
        projects_dir = Path("projects")
        if projects_dir.exists():
            for project_dir in projects_dir.iterdir():
                training_dir = project_dir / "training"
                if training_dir.exists():
                    print(f"Fixing permissions in {training_dir}")
                    fix_permissions(training_dir)
        else:
            print("Projects directory not found")
        
        # Also fix runs directory (where YOLO actually writes)
        runs_dir = Path("runs")
        if runs_dir.exists():
            print(f"Fixing permissions in {runs_dir}")
            fix_permissions(runs_dir)
        else:
            print("Runs directory not found (will be created by YOLO)")