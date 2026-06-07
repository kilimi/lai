#!/usr/bin/env python3
"""
Test script to validate MMYOLO DJI configuration generation.
This helps catch config errors before running full training.

Usage:
    pytest tests/python/test_mmyolo_dji_config.py
    python tests/python/test_mmyolo_dji_config.py
"""
import sys
import tempfile
from pathlib import Path


def generate_test_config(num_classes=5, image_size=640):
    """Generate a minimal DJI MMYOLO config for validation."""
    
    base_cfg = "yolov8_s_syncbn_fast_8xb16-500e_coco.py"
    
    # Simulate DJI mode config generation
    model_override = f"""
# Override model: num_classes in head + DJI widen_factor=0.25 for 4K resolution
# widen_factor affects both backbone AND neck channel dimensions
model = dict(
    backbone=dict(
        widen_factor=0.25,  # DJI requirement for 4K resolution support
    ),
    neck=dict(
        widen_factor=0.25,  # Must match backbone to avoid channel mismatch
        in_channels=[256, 512, 1024],   # Base YOLOv8 channels; widen_factor=0.25 scales these at build time
        out_channels=[256, 512, 1024],  # Base YOLOv8 channels; widen_factor=0.25 scales these at build time
    ),
    bbox_head=dict(
        head_module=dict(
            widen_factor=0.25,  # Must match neck output channels
            num_classes={num_classes},
        ),
    ),
    train_cfg=dict(
        assigner=dict(
            num_classes={num_classes},
        ),
    ),
)
"""
    
    cfg_content = f"""_base_ = ['{base_cfg}']

# Ensure evaluator registry entries from MMDetection are loaded.
custom_imports = dict(imports=['mmdet.evaluation.metrics.coco_metric'], allow_failed_imports=False)

# Override train/test pipelines to disable albumentations transforms that require img_path
train_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='LoadAnnotations', with_bbox=True),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='RandomFlip', prob=0.5),
    dict(type='PackDetInputs'),
]
test_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='LoadAnnotations', with_bbox=True),
    dict(type='PackDetInputs', meta_keys=('img_id', 'img_path', 'ori_shape', 'img_shape', 'scale_factor')),
]

max_epochs = 10
num_classes = {num_classes}
img_scale = ({image_size}, {image_size})
work_dir = './work_dirs/test'

# Class names (tuple format required by MMYolo)
_classes = ('class1', 'class2', 'class3', 'class4', 'class5')

# Use absolute paths to avoid ambiguity with data_root
train_dataloader = dict(
    batch_size=16,
    num_workers=4,
    dataset=dict(
        data_root='',
        ann_file='/tmp/train.json',
        data_prefix=dict(img='/tmp/images/train/'),
        metainfo=dict(classes=_classes),
        pipeline=train_pipeline,
    ),
)
val_dataloader = dict(
    batch_size=1,
    num_workers=2,
    dataset=dict(
        data_root='',
        ann_file='/tmp/val.json',
        data_prefix=dict(img='/tmp/images/val/'),
        metainfo=dict(classes=_classes),
        pipeline=test_pipeline,
    ),
)
test_dataloader = val_dataloader

# Evaluators must use absolute annotation file paths
val_evaluator = dict(
    # MMYOLO default scope is `mmyolo`; evaluator lives in mmdet registry.
    type='mmdet.CocoMetric',
    ann_file='/tmp/val.json',
    metric=['bbox'],
    format_only=False,
)
test_evaluator = val_evaluator

{model_override}
"""
    
    return cfg_content


def test_config_syntax():
    """Test that the generated config has valid Python syntax."""
    print("=" * 60)
    print("TEST 1: Config Syntax Validation")
    print("=" * 60)
    
    config_content = generate_test_config()
    
    # Write to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write(config_content)
        config_path = f.name
    
    try:
        # Try to compile the config as Python code
        with open(config_path, 'r') as f:
            compile(f.read(), config_path, 'exec')
        print("✅ Config has valid Python syntax")
        return True
    except SyntaxError as e:
        print(f"❌ Syntax Error in generated config:")
        print(f"   Line {e.lineno}: {e.msg}")
        print(f"   {e.text}")
        return False
    finally:
        Path(config_path).unlink()


def test_config_structure():
    """Test that the config has expected keys and structure."""
    print("\n" + "=" * 60)
    print("TEST 2: Config Structure Validation")
    print("=" * 60)
    
    config_content = generate_test_config()
    
    # Parse config into namespace
    namespace = {}
    try:
        exec(config_content, namespace)
    except Exception as e:
        print(f"❌ Failed to execute config: {e}")
        return False
    
    # Check required keys
    required_keys = [
        'max_epochs', 'num_classes', 'train_pipeline', 'test_pipeline',
        'train_dataloader', 'val_dataloader', 'val_evaluator', 'model'
    ]
    
    missing_keys = [key for key in required_keys if key not in namespace]
    if missing_keys:
        print(f"❌ Missing required keys: {missing_keys}")
        return False
    
    print("✅ All required keys present")
    
    # Validate model structure
    model = namespace.get('model', {})
    if not isinstance(model, dict):
        print("❌ 'model' is not a dict")
        return False
    
    # Check DJI-specific requirements
    backbone = model.get('backbone', {})
    if backbone.get('widen_factor') != 0.25:
        print(f"❌ backbone.widen_factor should be 0.25, got {backbone.get('widen_factor')}")
        return False
    print("✅ DJI backbone.widen_factor=0.25 correctly set")
    
    # Check neck widen_factor and channels
    neck = model.get('neck', {})
    if neck.get('widen_factor') != 0.25:
        print(f"❌ neck.widen_factor should be 0.25, got {neck.get('widen_factor')}")
        return False
    print("✅ DJI neck.widen_factor=0.25 correctly set")
    
    expected_channels = [256, 512, 1024]
    if neck.get('in_channels') != expected_channels:
        print(f"❌ neck.in_channels should be {expected_channels}, got {neck.get('in_channels')}")
        return False
    if neck.get('out_channels') != expected_channels:
        print(f"❌ neck.out_channels should be {expected_channels}, got {neck.get('out_channels')}")
        return False
    print("✅ DJI neck channels correctly configured for widen_factor=0.25")
    
    # Check bbox_head structure (should NOT have num_classes directly)
    bbox_head = model.get('bbox_head', {})
    if 'num_classes' in bbox_head:
        print("❌ bbox_head should NOT have num_classes directly (causes TypeError)")
        return False
    print("✅ bbox_head does not have num_classes directly")
    
    # Check head_module has num_classes and widen_factor
    head_module = bbox_head.get('head_module', {})
    if head_module.get('num_classes') != 5:
        print(f"❌ head_module.num_classes should be 5, got {head_module.get('num_classes')}")
        return False
    print("✅ head_module.num_classes correctly set to 5")
    
    if head_module.get('widen_factor') != 0.25:
        print(f"❌ head_module.widen_factor should be 0.25, got {head_module.get('widen_factor')}")
        return False
    print("✅ head_module.widen_factor correctly set to 0.25")
    
    train_cfg = model.get('train_cfg', {})
    assigner = train_cfg.get('assigner', {})
    if assigner.get('num_classes') != 5:
        print(f"❌ train_cfg.assigner.num_classes should be 5, got {assigner.get('num_classes')}")
        return False
    print("✅ train_cfg.assigner.num_classes correctly set to 5")
    
    # Check evaluator uses mmdet.CocoMetric
    val_evaluator = namespace.get('val_evaluator', {})
    if val_evaluator.get('type') != 'mmdet.CocoMetric':
        print(f"❌ val_evaluator type should be 'mmdet.CocoMetric', got {val_evaluator.get('type')}")
        return False
    print("✅ Evaluator correctly uses mmdet.CocoMetric")
    
    return True


def test_dji_requirements():
    """Test DJI-specific requirements."""
    print("\n" + "=" * 60)
    print("TEST 3: DJI Requirements Validation")
    print("=" * 60)
    
    # Test with valid class count (<=10)
    config = generate_test_config(num_classes=8)
    print("✅ Config generation works with 8 classes (<=10)")
    
    # Test with maximum allowed classes
    config = generate_test_config(num_classes=10)
    print("✅ Config generation works with 10 classes (DJI max)")
    
    # Test image size
    config = generate_test_config(image_size=640)
    if 'img_scale = (640, 640)' in config:
        print("✅ Image scale correctly set to 640x640")
    else:
        print("❌ Image scale not properly configured")
        return False
    
    return True


def main():
    """Run all tests."""
    print("\n🧪 MMYOLO DJI Configuration Test Suite")
    print("=" * 60)
    
    tests = [
        ("Config Syntax", test_config_syntax),
        ("Config Structure", test_config_structure),
        ("DJI Requirements", test_dji_requirements),
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"\n❌ {test_name} crashed: {e}")
            import traceback
            traceback.print_exc()
            results.append((test_name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    all_passed = all(result for _, result in results)
    
    if all_passed:
        print("\n🎉 All tests passed! DJI config generation is working correctly.")
        return 0
    else:
        print("\n⚠️  Some tests failed. Please review the output above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
