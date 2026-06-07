#!/usr/bin/env python3
"""Test loading YOLO segmentation dataset."""

import sys
import traceback
from pathlib import Path
import yaml

# Test loading with ultralytics
try:
    from ultralytics.data import YOLODataset
    from ultralytics.data.converter import convert_coco
    import torch
    
    # Load data.yaml
    data_yaml = "/app/projects/4/training/task_128/dataset/data.yaml"
    with open(data_yaml) as f:
        data = yaml.safe_load(f)
    
    print("Data config:")
    print(yaml.dump(data, default_flow_style=False))
    print("="*80)
    
    # Try to create dataset
    print("\nCreating YOLODataset with task='segment'...")
    train_path = Path(data['path']) / data['train']
    print(f"Train path: {train_path}")
    
    dataset = YOLODataset(
        img_path=str(train_path),
        data=data,
        task='segment',
        augment=False,
        batch_size=1
    )
    
    print(f"✓ Dataset created: {len(dataset)} images")
    
    # Try to load first item
    print("\nLoading first item...")
    item = dataset[0]
    print(f"✓ Item loaded")
    print(f"  Keys: {item.keys()}")
    
    if 'img' in item:
        print(f"  Image shape: {item['img'].shape}")
    
    if 'instances' in item:
        instances = item['instances']
        print(f"  Instances type: {type(instances)}")
        print(f"  Instances: {instances}")
        
        # Check segments
        if hasattr(instances, 'segments'):
            segs = instances.segments
            print(f"  Segments type: {type(segs)}")
            if isinstance(segs, list):
                print(f"  Number of segments: {len(segs)}")
                if segs:
                    print(f"  First segment shape: {segs[0].shape if hasattr(segs[0], 'shape') else len(segs[0])}")
            elif hasattr(segs, 'shape'):
                print(f"  Segments shape: {segs.shape}")
        
        # Check bboxes
        if hasattr(instances, 'bboxes'):
            bboxes = instances.bboxes
            print(f"  Bboxes type: {type(bboxes)}")
            if hasattr(bboxes, 'shape'):
                print(f"  Bboxes shape: {bboxes.shape}")
            else:
                print(f"  Bboxes: {bboxes}")
        
        # Check cls
        if hasattr(instances, 'cls'):
            cls = instances.cls
            print(f"  Classes type: {type(cls)}")
            if hasattr(cls, 'shape'):
                print(f"  Classes shape: {cls.shape}")
            else:
                print(f"  Classes: {cls}")
    
    # Try to get a batch
    print("\n" + "="*80)
    print("Testing batch loading...")
    from torch.utils.data import DataLoader
    
    def collate_fn(batch):
        return batch
    
    loader = DataLoader(dataset, batch_size=2, collate_fn=collate_fn)
    batch = next(iter(loader))
    print(f"✓ Batch loaded: {len(batch)} items")
    
except Exception as e:
    print(f"\n❌ Error: {e}")
    traceback.print_exc()
