#!/usr/bin/env python3
"""
Test script to verify YOLO training environment is properly configured
"""

import sys

import pytest

pytestmark = pytest.mark.training_smoke


def test_imports():
    """Test that all required packages can be imported (GPU worker / training env)."""
    pytest.importorskip("torch")
    pytest.importorskip("torchvision")
    pytest.importorskip("ultralytics")

    print("Testing imports...")
    packages = {
        "torch": "PyTorch",
        "torchvision": "TorchVision",
        "ultralytics": "Ultralytics YOLO",
        "cv2": "OpenCV",
        "numpy": "NumPy",
        "PIL": "Pillow",
    }

    failed = []
    for package, name in packages.items():
        try:
            __import__(package)
            print(f"✓ {name}")
        except ImportError as e:
            print(f"✗ {name}: {e}")
            failed.append(name)

    assert not failed, f"Failed imports: {failed}"


def test_cuda():
    """Test CUDA availability"""
    print("\nTesting CUDA...")
    torch = pytest.importorskip("torch")
    try:
        cuda_available = torch.cuda.is_available()
        print(f"CUDA available: {cuda_available}")
        
        if cuda_available:
            device_count = torch.cuda.device_count()
            print(f"GPU count: {device_count}")
            
            for i in range(device_count):
                name = torch.cuda.get_device_name(i)
                memory = torch.cuda.get_device_properties(i).total_memory / 1e9
                print(f"  GPU {i}: {name} ({memory:.2f} GB)")
            
            # Test tensor on GPU
            x = torch.randn(100, 100).cuda()
            y = x @ x.t()
            print("✓ GPU computation test passed")
        else:
            pytest.skip("CUDA not available, training will use CPU")
    except Exception as e:
        pytest.fail(f"CUDA test failed: {e}")


def test_ultralytics():
    """Test Ultralytics YOLO"""
    print("\nTesting Ultralytics...")
    pytest.importorskip("ultralytics")
    try:
        print("✓ YOLO import successful")
        print("✓ Ready to train YOLO models")
    except Exception as e:
        pytest.fail(f"Ultralytics test failed: {e}")

def main():
    print("=" * 60)
    print("YOLO Training Environment Test")
    print("=" * 60)
    
    results = []

    def _run(name, fn):
        try:
            fn()
            results.append((name, True))
        except Exception:
            results.append((name, False))

    _run("Imports", test_imports)
    _run("CUDA", test_cuda)
    _run("Ultralytics", test_ultralytics)
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    all_passed = True
    for name, passed in results:
        status = "✓ PASSED" if passed else "✗ FAILED"
        print(f"{name:20} {status}")
        if not passed:
            all_passed = False
    
    print("=" * 60)
    
    if all_passed:
        print("\n✓ All tests passed! Environment is ready for YOLO training.")
        return 0
    else:
        print("\n⚠ Some tests failed. Check the errors above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
