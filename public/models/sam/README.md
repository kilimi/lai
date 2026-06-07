# SAM Model Files

This directory should contain the ONNX model files for SAM (Segment Anything Model). **Encoder and decoder must match** (both MobileSAM or both SAM ViT); mixing them (e.g. MobileSAM encoder + ViT-H decoder) produces invalid masks.

## Required Files (MobileSAM – recommended for browser)

1. **mobile_sam.encoder.onnx** - MobileSAM encoder (~40MB)
2. **sam_mask_decoder_single.onnx** - MobileSAM decoder (~16.5MB), **matches the encoder**

### Direct download (matching pair)

**Acly/MobileSAM on Hugging Face** (encoder + decoder that work together):

- **Decoder (use this):**  
  https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx  
  Save as: `sam_mask_decoder_single.onnx` in this folder.

- **Encoder (if needed):**  
  https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx  
  If you use this file, rename it to `mobile_sam.encoder.onnx` (or point the app at this filename).

## Alternative: ViT-H decoder (not for MobileSAM encoder)

- **sam_vit_h_4b8939.decoder.onnx** - SAM ViT-H decoder (~350MB). Use only with a ViT-H encoder, not with MobileSAM encoder.
- Direct: https://huggingface.co/Rookiehan/sam/resolve/main/sam_vit_h_4b8939.decoder.onnx

### Option 2: Convert from PyTorch Models

If you have PyTorch models, convert them to ONNX:

#### For SAM Decoder:
```bash
# Install samexporter
pip install samexporter

# Download SAM checkpoint
# Then convert to ONNX
python -m samexporter.export_decoder \
    --checkpoint sam_vit_h_4b8939.pth \
    --output sam_vit_h_4b8939.decoder.onnx
```

#### For MobileSAM Encoder:
```python
import torch
import torch.onnx
from mobile_sam import sam_model_registry, SamPredictor

# Load MobileSAM
sam_checkpoint = "mobile_sam.pt"
model_type = "vit_t"
sam = sam_model_registry[model_type](checkpoint=sam_checkpoint)
sam.to(device='cpu')

# Export encoder
dummy_input = torch.randn(1, 3, 1024, 1024)
torch.onnx.export(
    sam.image_encoder,
    dummy_input,
    "mobile_sam.encoder.onnx",
    input_names=['x'],
    output_names=['image_embeddings'],
    dynamic_axes={'x': {0: 'batch'}, 'image_embeddings': {0: 'batch'}},
    opset_version=17
)
```

### Option 3: Use Alternative Models

If you can't find the exact models, you can use:

**Alternative Decoder Models:**
- `sam_vit_b_decoder.onnx` (smaller, faster)
- `sam_vit_l_decoder.onnx` (medium size)
- Any SAM decoder ONNX model should work

**Alternative Encoder Models:**
- `sam_vit_b_encoder.onnx`
- `sam_vit_l_encoder.onnx`
- MobileSAM encoder (recommended for speed)

## Installation Steps (MobileSAM – recommended)

1. **Download the matching decoder (required for Browser SAM):**
   ```bash
   cd public/models/sam
   wget -O sam_mask_decoder_single.onnx \
     "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx"
   ```

2. **Download or convert the encoder:**
   - Option A: From Acly/MobileSAM (then rename to `mobile_sam.encoder.onnx`):
     ```bash
     wget -O mobile_sam.encoder.onnx \
       "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx"
     ```
   - Option B: Convert MobileSAM PyTorch model to ONNX (see below)

3. **Verify files are in place:**
   ```bash
   ls -lh public/models/sam/
   # Should show:
   # mobile_sam.encoder.onnx
   # sam_mask_decoder_single.onnx
   ```

## Model Sources

- **SAM Original**: https://github.com/facebookresearch/segment-anything
- **MobileSAM**: https://github.com/ChaoningZhang/MobileSAM
- **SAM Exporter**: https://pypi.org/project/samexporter/
- **Hugging Face Models**: https://huggingface.co/models?search=sam+onnx

## File Structure (MobileSAM)

```
public/models/sam/
├── mobile_sam.encoder.onnx       (~40MB)
├── sam_mask_decoder_single.onnx  (~16.5MB, matches encoder)
└── README.md
```

## Troubleshooting

**Model not found:**
- Check file names match exactly (case-sensitive)
- Verify files are in `public/models/sam/` directory
- Check browser console for 404 errors

**Model too large:**
- Consider using smaller models (vit_b or vit_l instead of vit_h)
- Use MobileSAM encoder (much smaller than full SAM encoder)

**Conversion issues:**
- Ensure PyTorch version compatibility
- Use ONNX opset version 17 or higher
- Check model input/output shapes match expected format

## Quick Start Script (MobileSAM)

```bash
#!/bin/bash
# Download MobileSAM encoder + decoder (matching pair for browser)

cd public/models/sam

echo "Downloading MobileSAM decoder..."
wget -O sam_mask_decoder_single.onnx \
  "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx"

echo "Downloading MobileSAM encoder..."
wget -O mobile_sam.encoder.onnx \
  "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx"

echo "Done. Verify with: ls -lh"
```

## Model Specifications

**Decoder Input:**
- `image_embeddings`: [1, 256, 64, 64] (from encoder)
- `point_coords`: [1, N, 2] (click coordinates)
- `point_labels`: [1, N] (1 for positive, 0 for negative)

**Decoder Output:**
- `masks`: [1, N, 256, 256] (segmentation masks)
- `scores`: [1, N] (confidence scores)

**Encoder Input:**
- `x`: [1, 3, 1024, 1024] (preprocessed image)

**Encoder Output:**
- `image_embeddings`: [1, 256, 64, 64] (image features)
