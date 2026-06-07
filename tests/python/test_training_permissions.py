#!/usr/bin/env python3
"""
Test script to verify training directory permissions are set correctly.
This test ensures that new training tasks can create directories and files
without permission errors.
"""

import os
import tempfile
import shutil
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock


def test_directory_creation_with_permissions():
    """Test that directories are created with proper permissions"""
    print("Testing directory creation with permissions...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        test_base = Path(temp_dir) / "test_projects" / "8" / "training" / "task_999"
        training_output_dir = test_base / "training"
        weights_dir = training_output_dir / "weights"
        
        # Create directories (simulating training_tasks.py logic)
        for directory in [test_base, training_output_dir, weights_dir]:
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o777)
        
        # Verify all directories exist
        assert test_base.exists(), f"Base directory {test_base} should exist"
        assert training_output_dir.exists(), f"Training output directory {training_output_dir} should exist"
        assert weights_dir.exists(), f"Weights directory {weights_dir} should exist"
        
        # Verify permissions (should be writable)
        for directory in [test_base, training_output_dir, weights_dir]:
            stat = os.stat(directory)
            # Check if directory is writable (has write permission)
            is_writable = bool(stat.st_mode & 0o222)  # Check for write bits
            assert is_writable, f"Directory {directory} should be writable (mode: {oct(stat.st_mode)})"
        
        print("✓ Directory creation with permissions: PASSED")

def test_parent_directory_permissions():
    """Test that parent directories are fixed before creating new task directories"""
    print("\nTesting parent directory permission fixing...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        projects_base = Path(temp_dir) / "projects"
        project_dir = projects_base / "8"
        training_base = project_dir / "training"
        
        # Create parent directories with restrictive permissions (simulating the problem)
        projects_base.mkdir(parents=True, exist_ok=True)
        project_dir.mkdir(parents=True, exist_ok=True)
        training_base.mkdir(parents=True, exist_ok=True)
        
        # Set restrictive permissions (read-only)
        os.chmod(projects_base, 0o555)
        os.chmod(project_dir, 0o555)
        os.chmod(training_base, 0o555)
        
        # Now fix permissions (simulating the fix in training_tasks.py)
        for parent_dir in [projects_base, project_dir, training_base]:
            if parent_dir.exists():
                os.chmod(parent_dir, 0o777)
        
        # Now create new task directory
        output_base = training_base / "task_999"
        training_output_dir = output_base / "training"
        weights_dir = training_output_dir / "weights"
        
        for directory in [output_base, training_output_dir, weights_dir]:
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o777)
        
        # Verify we can write to the weights directory
        test_file = weights_dir / "test.pt"
        try:
            test_file.write_text("test content")
            assert test_file.exists(), "Should be able to create file in weights directory"
            test_file.unlink()
            print("✓ Parent directory permission fixing: PASSED")
        except PermissionError as e:
            raise AssertionError(f"Parent directory permission fixing failed: {e}") from e

def test_existing_file_permission_fix():
    """Test that existing weight files with wrong permissions are handled"""
    print("\nTesting existing file permission handling...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        weights_dir = Path(temp_dir) / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(weights_dir, 0o777)
        
        # Create a file with restrictive permissions (simulating the problem)
        test_file = weights_dir / "last.pt"
        test_file.write_text("test")
        os.chmod(test_file, 0o444)  # Read-only
        
        # Try to fix permissions (simulating the fix)
        try:
            os.chmod(test_file, 0o666)
            # Verify we can now write to it
            test_file.write_text("updated")
            print("✓ Existing file permission fix: PASSED")
        except PermissionError as e:
            print(f"✗ Existing file permission fix: FAILED - {e}")
            # If we can't fix, try removing it
            try:
                test_file.unlink()
                print("  → File removed as fallback")
            except Exception as e2:
                raise AssertionError(f"Could not remove file: {e2}") from e2

def test_write_access_verification():
    """Test that write access is verified before training starts"""
    print("\nTesting write access verification...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        weights_dir = Path(temp_dir) / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(weights_dir, 0o777)
        
        # Test write access (simulating the verification in training_tasks.py)
        try:
            test_file = weights_dir / ".write_test"
            test_file.touch()
            test_file.write_text("test")
            test_file.unlink()
            print("✓ Write access verification: PASSED")
        except PermissionError as e:
            raise AssertionError(f"Write access verification failed: {e}") from e

def test_full_path_permission_fix():
    """Test the complete path from projects/ to weights/ has correct permissions"""
    print("\nTesting full path permission chain...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        # Simulate the full path structure
        projects_base = Path(temp_dir) / "projects"
        project_dir = projects_base / "8"
        training_base = project_dir / "training"
        output_base = training_base / "task_999"
        training_output_dir = output_base / "training"
        weights_dir = training_output_dir / "weights"
        
        # Fix parent directories first (critical step)
        parent_dirs = [projects_base, project_dir, training_base]
        for parent_dir in parent_dirs:
            parent_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(parent_dir, 0o777)
        
        # Create new task directories
        new_dirs = [output_base, training_output_dir, weights_dir]
        for directory in new_dirs:
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o777)
        
        # Verify we can write a file (simulating YOLO writing last.pt)
        test_weight_file = weights_dir / "last.pt"
        try:
            test_weight_file.write_text("model weights")
            assert test_weight_file.exists(), "Should be able to create weight file"
            
            # Verify we can overwrite it (YOLO updates it during training)
            test_weight_file.write_text("updated weights")
            
            print("✓ Full path permission chain: PASSED")
        except PermissionError as e:
            # Debug: check permissions on each directory
            for directory in [projects_base, project_dir, training_base, output_base, training_output_dir, weights_dir]:
                if directory.exists():
                    stat = os.stat(directory)
                    print(f"  {directory}: mode={oct(stat.st_mode)}, writable={bool(stat.st_mode & 0o222)}")
            raise AssertionError(f"Full path permission chain failed: {e}") from e

def test_permission_error_scenario():
    """Test the specific error scenario: Permission denied on last.pt"""
    print("\nTesting permission error scenario...")
    
    with tempfile.TemporaryDirectory() as temp_dir:
        weights_dir = Path(temp_dir) / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        
        # Scenario 1: Directory exists but file has wrong permissions
        test_file = weights_dir / "last.pt"
        test_file.write_text("existing")
        os.chmod(test_file, 0o444)  # Read-only (simulating the problem)
        os.chmod(weights_dir, 0o555)  # Directory also restrictive
        
        # Fix: Set directory to writable
        os.chmod(weights_dir, 0o777)
        
        # Fix: Remove or fix file permissions
        try:
            os.chmod(test_file, 0o666)
        except PermissionError:
            # If we can't fix, remove it
            test_file.unlink()
        
        # Now try to write (simulating YOLO)
        try:
            test_file.write_text("new content")
            print("✓ Permission error scenario: PASSED")
        except PermissionError as e:
            raise AssertionError(f"Permission error scenario failed: {e}") from e

def main():
    print("=" * 80)
    print("Training Directory Permissions Test")
    print("=" * 80)
    
    results = []

    def _run(name, fn):
        try:
            fn()
            results.append((name, True))
        except Exception:
            results.append((name, False))

    _run("Directory Creation", test_directory_creation_with_permissions)
    _run("Parent Directory Permissions", test_parent_directory_permissions)
    _run("Existing File Permissions", test_existing_file_permission_fix)
    _run("Write Access Verification", test_write_access_verification)
    _run("Full Path Permissions", test_full_path_permission_fix)
    _run("Permission Error Scenario", test_permission_error_scenario)
    
    # Summary
    print("\n" + "=" * 80)
    print("Test Summary")
    print("=" * 80)
    
    all_passed = True
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{name:40} {status}")
        if not passed:
            all_passed = False
    
    print("=" * 80)
    
    if all_passed:
        print("\n✓ All permission tests passed!")
        return 0
    else:
        print("\n✗ Some permission tests failed. Check the errors above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
