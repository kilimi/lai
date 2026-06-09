#!/usr/bin/env python3
"""Find annotations with mismatched bbox/segmentation."""

from pathlib import Path

dataset_dir = Path("/app/projects/4/training/task_128/dataset")

for split in ['train', 'val']:
    label_dir = dataset_dir / "labels" / split
    print(f"\nChecking {split} labels...")
    
    for label_file in label_dir.glob("*.txt"):
        with open(label_file) as f:
            lines = f.readlines()
        
        issues = []
        for i, line in enumerate(lines, 1):
            parts = line.strip().split()
            if len(parts) < 2:
                issues.append(f"Line {i}: Empty or invalid")
                continue
            
            class_id = parts[0]
            coords = parts[1:]
            
            # For segmentation, should have at least 6 coords (3 points)
            if len(coords) < 6:
                issues.append(f"Line {i}: Only {len(coords)} coords (need at least 6 for segmentation)")
            
            # Check if looks like bbox (exactly 4 coords)
            if len(coords) == 4:
                issues.append(f"Line {i}: Exactly 4 coords - looks like bbox, not segmentation!")
        
        if issues:
            print(f"\n  ❌ {label_file.name}:")
            for issue in issues:
                print(f"      {issue}")
