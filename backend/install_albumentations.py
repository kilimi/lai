#!/usr/bin/env python3
"""
Installation script for Albumentations and its dependencies.
Run this script to install the required packages for image augmentation.
"""

import subprocess
import sys
import os

def install_package(package):
    """Install a package using pip"""
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])
        print(f"✅ Successfully installed {package}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to install {package}: {e}")
        return False

def main():
    """Install all required packages"""
    print("🚀 Installing Albumentations and dependencies...")
    print("=" * 50)
    
    packages = [
        "albumentations>=1.3.0",
        "opencv-python>=4.8.0", 
        "pillow>=9.0.0",
        "numpy>=1.21.0"
    ]
    
    successful = 0
    failed = 0
    
    for package in packages:
        print(f"\nInstalling {package}...")
        if install_package(package):
            successful += 1
        else:
            failed += 1
    
    print("\n" + "=" * 50)
    print(f"Installation complete!")
    print(f"✅ Successful: {successful}")
    print(f"❌ Failed: {failed}")
    
    if failed == 0:
        print("\n🎉 All packages installed successfully!")
        print("You can now use Albumentations for image augmentation.")
        
        # Test the installation
        try:
            import albumentations as A
            import cv2
            import numpy as np
            from PIL import Image
            print(f"\n✅ Import test passed!")
            print(f"   Albumentations version: {A.__version__}")
            print(f"   OpenCV version: {cv2.__version__}")
        except ImportError as e:
            print(f"\n❌ Import test failed: {e}")
    else:
        print(f"\n⚠️  Some packages failed to install. Please check the errors above.")
        print("You may need to install them manually or check your environment.")

if __name__ == "__main__":
    main()
