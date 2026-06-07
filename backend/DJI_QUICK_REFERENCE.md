# DJI MMYolo Training - Quick Reference

## 🚁 Quick Start

### 1. Prepare Your Dataset
```
✓ Annotations in COCO JSON format
✓ Maximum 10 object classes
✓ Valid bounding boxes for all annotations
✓ Images with proper dimensions
```

### 2. Get the DJI Patch File
- Obtain `0001-NEW-ai-inside-init.patch` from DJI
- Place in accessible location (e.g., `/app/patches/`)

### 3. Start Training via API
```bash
POST /api/training/mmyolo/start
{
  "project_id": 1,
  "dataset_configs": [...],
  "arch": "rtmdet",
  "size": "s",
  "task": "detect",
  "epochs": 300,
  "batch_size": 16,
  "dji_patch_path": "/app/patches/0001-NEW-ai-inside-init.patch"
}
```

---

## 🔧 What Happens Automatically

When `dji_patch_path` is provided:

| Feature | Automatic Behavior |
|---------|-------------------|
| **Config File** | Forces `yolov8_s_syncbn_fast_8xb16-500e_coco` |
| **MMYolo Version** | Checks out `v0.6.0` tag |
| **Widen Factor** | Sets to `0.25` (4K support) |
| **Class Validation** | Enforces `num_classes ≤ 10` |
| **Paths** | Uses absolute paths throughout |
| **Patch Application** | Applies DJI patch automatically |

---

## ✅ Pre-Training Checklist

- [ ] Dataset has ≤ 10 annotation classes
- [ ] All images have valid dimensions in DB or on disk
- [ ] All annotations have `category_id` set
- [ ] Bounding boxes are in correct format `[x, y, w, h]`
- [ ] DJI patch file exists and is readable
- [ ] GPU is available (recommended for training)

---

## ⚠️ Common Errors & Solutions

### "num_classes exceeds 10"
```
❌ DJI drone models require num_classes <= 10
✓ Solution: Merge similar classes or create separate models
```

### "DJI patch file not found"
```
❌ DJI patch file not found: /path/to/patch
✓ Solution: Check file path and permissions
```

### "Annotation skipped: no category_id"
```
❌ Annotation 123 has no category_id, skipping
✓ Solution: Ensure all annotations have category_id set in database
```

### "Cannot find image files"
```
❌ Image file not found: projects/1/image.jpg
✓ Solution: Verify image paths and file existence
```

---

## 📊 Training Progress Tracking

Monitor via task metadata:
```json
{
  "stage": "training",
  "current_epoch": 50,
  "total_epochs": 300,
  "num_classes": 5,
  "dji_mode": true
}
```

---

## 📦 Deliverables for DJI

After training completes, send to DJI:

1. **Model File**: `projects/{project_id}/training/task_{id}/training/best.pth`
2. **Config File**: `projects/{project_id}/training/task_{id}/mmyolo_config.py`
3. **Calibration Images**: Representative validation subset (DJI will specify)

---

## 🔍 Validation Logs to Watch

```log
✓ INFO: DJI mode enabled: forcing config to yolov8_s...
✓ INFO: Read image dimensions from file: 1920x1080
✓ INFO: Patch applied successfully
✓ INFO: DJI MMYolo repo prepared successfully

⚠️ WARNING: Annotation 456 has no category_id, skipping
⚠️ WARNING: Annotation 789: polygon contains non-numeric values
```

---

## 🐛 Debug Mode

Enable detailed logging:
```python
import logging
logging.getLogger('app.tasks.training_tasks').setLevel(logging.DEBUG)
logging.getLogger('app.routers.training').setLevel(logging.DEBUG)
```

---

## 📚 File Structure After Training

```
projects/{project_id}/training/task_{id}/
├── dataset/
│   ├── annotations/
│   │   ├── train.json    # COCO format
│   │   └── val.json      # COCO format
│   └── images/
│       ├── train/
│       └── val/
├── training/              # MMYolo work_dir
│   ├── best.pth          # ← Send to DJI
│   ├── epoch_*.pth       # Checkpoints
│   └── logs/
└── mmyolo_config.py      # ← Send to DJI
```

---

## 🎯 Performance Tips

1. **Batch Size**: Start with 16, adjust based on GPU memory
2. **Epochs**: 300 is standard, can reduce for testing
3. **Image Size**: 640 works well, larger for more detail
4. **Augmentations**: Enabled by default in base config
5. **Validation**: Monitor validation loss for overfitting

---

## 🔗 Related Documentation

- Full Guide: [`DJI_MMYOLO_TRAINING_GUIDE.md`](DJI_MMYOLO_TRAINING_GUIDE.md)
- Implementation Details: [`MMYOLO_DJI_FIX_SUMMARY.md`](MMYOLO_DJI_FIX_SUMMARY.md)
- MMYolo Docs: https://mmyolo.readthedocs.io/
- DJI Enterprise: https://enterprise.dji.com/

---

## 💡 Pro Tips

- **Test First**: Train with 2-3 classes before full 10-class model
- **Check Logs**: Always review logs for warnings about skipped data
- **Validate JSON**: Use `json.load()` to check COCO JSON before training
- **Save Configs**: Keep a copy of generated config for reference
- **Monitor Training**: Watch for loss convergence and validation metrics

---

**Last Updated**: May 26, 2026  
**Version**: 1.0  
**Status**: Production Ready ✓
