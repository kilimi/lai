#!/usr/bin/env python3
"""
Dependency compatibility checker for Stable Diffusion Inpainting
This script checks if the package versions are compatible before building Docker images.
"""

import subprocess
import sys
import tempfile
import os

def create_test_requirements(versions):
    """Create a temporary requirements file with specified versions"""
    content = "\n".join([f"{pkg}=={ver}" for pkg, ver in versions.items()])
    return content

def test_dependency_resolution(versions, name):
    """Test if a set of package versions can be resolved"""
    print(f"\n=== Testing {name} ===")
    
    # Create temporary requirements file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write(create_test_requirements(versions))
        req_file = f.name
    
    try:
        # Use pip's dependency resolver to check compatibility
        cmd = [sys.executable, '-m', 'pip', 'install', '--dry-run', '-r', req_file]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        
        if result.returncode == 0:
            print(f"✓ {name}: All dependencies compatible!")
            return True
        else:
            print(f"✗ {name}: Dependency conflict detected")
            print("Error output:")
            print(result.stderr[-500:])  # Last 500 chars of error
            return False
            
    except subprocess.TimeoutExpired:
        print(f"⚠ {name}: Dependency resolution timed out")
        return False
    except Exception as e:
        print(f"✗ {name}: Error during testing: {e}")
        return False
    finally:
        os.unlink(req_file)

def main():
    print("Stable Diffusion Inpainting - Dependency Compatibility Checker")
    print("=" * 60)
    
    # Define different version sets to test
    version_sets = {
        "Stable Set (Recommended)": {
            "torch": "2.0.1",
            "torchvision": "0.15.2", 
            "huggingface-hub": "0.15.1",
            "tokenizers": "0.13.3",
            "transformers": "4.30.2",
            "diffusers": "0.18.2",
            "accelerate": "0.20.3",
            "safetensors": "0.3.1"
        },
        
        "Conservative Set": {
            "torch": "1.13.1",
            "torchvision": "0.14.1",
            "huggingface-hub": "0.14.1",
            "tokenizers": "0.13.2",
            "transformers": "4.28.1",
            "diffusers": "0.16.1",
            "accelerate": "0.18.0",
            "safetensors": "0.3.0"
        },
        
        "Latest Compatible Set": {
            "torch": "2.1.0",
            "huggingface-hub": "0.16.4",
            "tokenizers": "0.13.3",
            "transformers": "4.31.0",
            "diffusers": "0.21.4",
            "accelerate": "0.21.0",
            "safetensors": "0.3.1"
        }
    }
    
    results = {}
    
    for name, versions in version_sets.items():
        results[name] = test_dependency_resolution(versions, name)
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    for name, success in results.items():
        status = "✓ COMPATIBLE" if success else "✗ CONFLICTS"
        print(f"{name}: {status}")
    
    # Recommend the best option
    print("\n" + "=" * 60)
    print("RECOMMENDATION")
    print("=" * 60)
    
    if results.get("Stable Set (Recommended)", False):
        print("✓ Use the 'Stable Set' versions - they are tested and compatible!")
        print("  Build with: Dockerfile.inpainting.stable")
    elif results.get("Conservative Set", False):
        print("✓ Use the 'Conservative Set' versions - older but reliable!")
    elif results.get("Latest Compatible Set", False):
        print("✓ Use the 'Latest Compatible Set' versions - newer with some risk!")
    else:
        print("⚠ All tested version sets have conflicts.")
        print("  Consider using conda instead of pip for better dependency resolution.")
        print("  Or try installing packages one by one to identify the conflicting package.")
    
    print("\nNext steps:")
    print("1. If a compatible set is found, use the corresponding Dockerfile")
    print("2. If no set works, try the alternative installation methods")
    print("3. Check Docker build logs for specific error messages")

if __name__ == "__main__":
    main()