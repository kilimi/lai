# DJI MMYolo Training Guide

## Overview
This guide explains how to train object detection models compatible with DJI Enterprise drones using MMYolo.

## DJI Requirements

### 1. **Model Configuration**
- **Framework**: MMYolo v0.6.0 (fixed version)
- **Config File**: `yolov8_s_syncbn_fast_8xb16-500e_coco.py` (enforced automatically in DJI mode)
- **Max Classes**: num_classes ≤ 10 (validated automatically)
- **Architecture Modification**: `widen_factor = 0.25` (applied automatically for 4K resolution support)

### 2. **Training Workflow**
```bash
# Step 1: Clone and setup MMYolo (handled automatically)
git clone https://github.com/open-mmlab/mmyolo.git
cd mmyolo
git checkout tags/v0.6.0
git switch -c drone-model-training

# Step 2: Apply DJI patch (provide path in training request)
git apply /path/to/0001-NEW-ai-inside-init.patch

# Step 3: Train (handled by system)
CUDA_VISIBLE_DEVICES=0,1,2,3 ./tools/dist_train.sh \
    configs/yolov8/yolov8_s_syncbn_fast_8xb16-500e_coco.py 4
```

### 3. **Critical Configuration Changes**

#### For 4K Resolution Support
The system automatically modifies `widen_factor` in the model backbone:
```python
model = dict(
    backbone=dict(
        widen_factor=0.25,  # Changed from 0.5 to 0.25
    ),
)
```
**Why?** Without this change, quantization will fail during calibration/validation.

## Using the API

### Training Request Example
```json
{
  "project_id": 1,
  "dataset_configs": [
    {
      "dataset_id": 1,
      "annotation_file_id": 1,
      "split": {"train": 80, "val": 20, "test": 0}
    }
  ],
  "arch": "rtmdet",
  "size": "s",
  "task": "detect",
  "epochs": 300,
  "batch_size": 16,
  "image_size": 640,
  "device": "0",
  "dji_patch_path": "/app/patches/0001-NEW-ai-inside-init.patch",
  "remove_images_without_annotations": true
}
```

### Important Parameters
- **`dji_patch_path`**: Path to DJI patch file. When set, automatically:
  - Enforces yolov8_s configuration
  - Validates num_classes ≤ 10
  - Applies widen_factor=0.25
  - Uses mmyolo v0.6.0

## Annotation Requirements

### Dataset Format
- **Format**: COCO JSON
- **Required Fields**:
  - `images`: id, file_name, width, height
  - `annotations`: id, image_id, category_id, bbox, area
  - `categories`: id (1-indexed), name

### Critical Fixes Applied
The system now includes robust error handling for:
1. **Empty segmentation arrays**: Prevents IndexError crashes
2. **Missing category_id**: Logs warning instead of silent failure
3. **Invalid dimensions**: Falls back to reading actual image file
4. **Non-numeric polygons**: Validates and skips invalid data

### Validation Checks
```python
# Automatic validations:
✓ category_id is not None
✓ Image dimensions > 0 (reads from file if needed)
✓ Segmentation polygons have ≥6 coordinates
✓ All polygon coordinates are numeric
✓ Bounding boxes are in correct [x, y, w, h] format
```

## Generated Config Structure

### Absolute Paths (Fixed)
The system generates configs with absolute paths to avoid ambiguity:
```python
train_dataloader = dict(
    batch_size=16,
    dataset=dict(
        data_root='',
        ann_file='/app/projects/1/training/task_123/dataset/annotations/train.json',
        data_prefix=dict(img='/app/projects/1/training/task_123/dataset/images/train/'),
        metainfo=dict(classes=('class1', 'class2', ...)),
    ),
)
```

### Model Head Override
```python
model = dict(
    bbox_head=dict(
        num_classes=5,
        head_module=dict(
            num_classes=5,
        ),
    ),
)
```

## Deliverables for DJI

After training completes, send to DJI:
1. **Trained model**: `best.pth` file from work_dir
2. **Calibration images**: Representative subset of validation images (DJI will specify requirements)
3. **Config file**: The generated `mmyolo_config.py`

DJI will handle:
- Model quantization
- Calibration validation
- Deployment to drone

## Troubleshooting

### Error: "num_classes exceeds 10"
**Solution**: Reduce the number of annotation classes in your dataset to 10 or fewer.

### Error: "DJI patch file not found"
**Solution**: Ensure the patch file path is correct and accessible to the backend container.

### Error: "Cannot find image files"
**Check**:
1. Image paths in database are correct
2. Files exist in `projects/{dataset_id}/` directory
3. Image dimensions are set in database or readable from files

### Error: "Segmentation polygon invalid"
**Check**:
1. Polygons have at least 3 points (6 coordinates)
2. All coordinates are numeric (not strings or null)
3. Coordinates are in correct format: [x1, y1, x2, y2, x3, y3, ...]

### Warning: "Annotations skipped"
**Check logs for**:
- Missing category_id
- Invalid segmentation data
- Zero-dimension images

## Configuration Files

### Environment Variables
```bash
MMYOLO_DJI_REPO_DIR=/app/data/mmyolo_dji  # Where to clone mmyolo
MMYOLO_PYTHON=/opt/mmyolo-venv/bin/python  # Python interpreter for training
```

### Patch File Location
Place the DJI patch file at a location accessible to the backend, e.g.:
```
/app/patches/0001-NEW-ai-inside-init.patch
```

## Testing the Setup

### 1. Verify Dataset
```bash
# Check COCO JSON is valid
python -c "import json; json.load(open('annotations/train.json'))"

# Verify image count
ls images/train/ | wc -l
```

### 2. Test Config Generation
The system will log the generated config path. Inspect it to verify:
- Absolute paths are correct
- num_classes matches your dataset
- widen_factor=0.25 is present (if DJI mode)

### 3. Monitor Training
Watch logs for:
- Epoch progress
- Loss values
- Validation metrics

## Best Practices

1. **Start Small**: Test with 2-3 classes before full 10-class training
2. **Validate Annotations**: Review COCO JSON before training
3. **Check Image Quality**: Ensure images are clear and properly labeled
4. **Monitor Resources**: Training requires GPU with sufficient VRAM
5. **Save Checkpoints**: Enable periodic saving during long training runs

## Additional Resources

- [MMYolo Documentation](https://mmyolo.readthedocs.io/)
- [COCO Dataset Format](https://cocodataset.org/#format-data)
- [DJI Enterprise Drone Documentation](https://enterprise.dji.com/)

## Support

For issues specific to:
- **MMYolo**: Check MMYolo GitHub issues
- **DJI Integration**: Contact DJI support with model files
- **System Bugs**: Check application logs and report with task_id
