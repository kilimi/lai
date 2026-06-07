#!/usr/bin/env python3
"""Test if YOLO can load the generated dataset."""

import sys
from pathlib import Path

try:
    from ultralytics.data import YOLODataset
    from ultralytics.data.utils import check_det_dataset
    import yaml
    
    # Load data.yaml
    data_yaml = Path("/app/projects/4/training/task_127/dataset/data.yaml")
    with open(data_yaml) as f:
        data_dict = yaml.safe_load(f)
    
    print("="*80)
    print("Data YAML content:")
    print(yaml.dump(data_dict, default_flow_style=False))
    print("="*80)
    
    # Try to check/validate the dataset
    print("\nValidating dataset...")
    try:
        checked_data = check_det_dataset(data_dict)
        print("✓ Dataset validation passed")
        print(f"Checked data: {checked_data}")
    except Exception as e:
        print(f"❌ Dataset validation failed: {e}")
        import traceback
        traceback.print_exc()
    
    # Try to load the dataset
    print("\n" + "="*80)
    print("Attempting to load training dataset...")
    print("="*80)
    
    try:
        dataset_path = Path(data_dict['path'])
        train_path = dataset_path / data_dict['train']
        
        print(f"Dataset path: {dataset_path}")
        print(f"Train images path: {train_path}")
        
        # Create dataset with task='segment'
        dataset = YOLODataset(
            img_path=str(train_path),
            data=data_dict,
            task='segment',
            batch_size=1
        )
        
        print(f"✓ Dataset loaded successfully!")
        print(f"  Number of images: {len(dataset)}")
        
        # Try to get first item
        if len(dataset) > 0:
            print("\n  Loading first item...")
            item = dataset[0]
            print(f"  ✓ First item loaded")
            print(f"    Image shape: {item.get('img', 'N/A')}")
            if 'instances' in item:
                instances = item['instances']
                print(f"    Instances: {instances}")
                if hasattr(instances, 'segments'):
                    print(f"    Segments shape: {instances.segments.shape if hasattr(instances.segments, 'shape') else len(instances.segments)}")
                if hasattr(instances, 'bboxes'):
                    print(f"    Bboxes shape: {instances.bboxes.shape if hasattr(instances.bboxes, 'shape') else len(instances.bboxes)}")
        
    except Exception as e:
        print(f"❌ Failed to load dataset: {e}")
        import traceback
        traceback.print_exc()

except Exception as e:
    print(f"❌ Fatal error: {e}")
    import traceback
    traceback.print_exc()
