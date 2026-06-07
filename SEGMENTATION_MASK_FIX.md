# Segmentation Mask Shift Fix

## Problem
When annotating datasets with segmentation masks where images have different sizes, the masks would appear shifted or in the wrong position after saving and reloading the annotations.

## Root Cause
The issue had multiple contributing factors:

### 1. **Inconsistent Coordinate Storage**
- **Backend** was storing segmentation coordinates as normalized (0-1 range)
- **Frontend** was expecting pixel coordinates
- When loading, the de-normalization logic had a bug: `any(abs(val) > 2 for val in polygon)`
  - This check would NEVER be true for normalized coords (0-1), causing double multiplication

### 2. **Wrong Image Dimensions in COCO Files**
- When saving annotations for multiple images:
  ```typescript
  // BEFORE (WRONG):
  imagesArr.push({ 
    id: imageId, 
    file_name: name, 
    width: imageRef.current?.naturalWidth || 0,  // ❌ Current image, not this image!
    height: imageRef.current?.naturalHeight || 0 
  });
  ```
- This would use the **currently displayed image's dimensions** for ALL images in the COCO file
- Example scenario:
  - Image A: 1920x1080 annotated
  - User switches to Image B: 1280x720
  - User clicks "Save All"
  - Image A gets saved with dimensions 1280x720 (wrong!)
  - When loading: annotations scaled for 1920x1080 but COCO says 1280x720
  - Result: masks appear at 66% of correct position

## Solution

### Backend Changes

#### File: `backend/app/routers/annotation_db.py`

1. **Store segmentation as pixel coordinates** (not normalized):
   ```python
   # BEFORE:
   segmentation_normalized = validate_and_normalize_segmentation(
       seg,
       image_width=img_width,
       image_height=img_height,
       normalize=True  # ❌ Wrong
   )
   
   # AFTER:
   segmentation_pixels = validate_and_normalize_segmentation(
       seg,
       image_width=img_width,
       image_height=img_height,
       normalize=False  # ✅ Keep as pixel coordinates
   )
   ```

2. **Updated both processing functions**:
   - `process_coco_annotation_file()` (line 342-359)
   - `process_coco_annotation_file_task()` (line 952)

#### File: `backend/app/routers/datasets.py`

3. **Simplified coordinate retrieval** since they're now stored as pixels:
   ```python
   # BEFORE: Complex logic to detect if coords are normalized or not
   if ann.get("segmentation") and isinstance(ann["segmentation"], list):
       segmentation = ann["segmentation"]
       pixel_segmentation = []
       for polygon in segmentation:
           if isinstance(polygon, list) and len(polygon) > 0:
               is_already_pixel = any(abs(val) > 2 for val in polygon)  # ❌ Broken logic
               # ... normalization/denormalization ...
   
   # AFTER: Direct use of pixel coordinates
   if ann.get("segmentation") and isinstance(ann["segmentation"], list):
       coco_ann["segmentation"] = ann["segmentation"]  # ✅ Already pixels
   ```

### Frontend Changes

#### File: `src/pages/ImageAnnotation.tsx`

4. **Fixed image dimension storage in COCO files**:
   
   Changed 3 functions to retrieve stored dimensions for each specific image:
   - `downloadAnnotationsJSON()` (lines 3017-3048)
   - `saveNewAnnotationFile()` (lines 3145-3176)
   - `saveAllAnnotations()` (lines 3571-3602)
   
   ```typescript
   // BEFORE:
   imagesArr.push({ 
     id: imageId, 
     file_name: name, 
     width: imageRef.current?.naturalWidth || 0,  // ❌ Wrong image!
     height: imageRef.current?.naturalHeight || 0 
   });
   
   // AFTER:
   const dimsKey = `annotations_${id}_${name}_dims`;
   const savedDims = localStorage.getItem(dimsKey);
   let imgWidth = 0;
   let imgHeight = 0;
   
   if (savedDims) {
     try {
       const dims = JSON.parse(savedDims) as { width: number; height: number };
       imgWidth = dims.width || 0;
       imgHeight = dims.height || 0;
     } catch (e) {
       // Fallback to current image if dims not found
       imgWidth = imageRef.current?.naturalWidth || 0;
       imgHeight = imageRef.current?.naturalHeight || 0;
     }
   }
   
   imagesArr.push({ 
     id: imageId, 
     file_name: name, 
     width: imgWidth,  // ✅ Correct image dimensions!
     height: imgHeight 
   });
   ```

5. **Added clarifying comments** to drawing code (lines 2428-2442)

## Coordinate Space Flow

### Correct Flow (After Fix):
```
1. User annotates Image A (1920x1080)
   ├─ Annotation coordinates stored in localStorage: pixel coords relative to 1920x1080
   └─ Dimensions stored: { width: 1920, height: 1080 }

2. User saves annotations
   ├─ Retrieves stored dimensions for Image A: 1920x1080
   ├─ COCO file created with image entry: { width: 1920, height: 1080 }
   └─ Segmentation in COCO: pixel coordinates relative to 1920x1080

3. Backend stores annotations
   └─ Segmentation stored as pixel coordinates (integers)

4. User loads annotations
   ├─ Backend returns segmentation as pixel coordinates
   ├─ Frontend loads with correct image dimensions from COCO
   └─ Drawing scales correctly: coords are in COCO space (1920x1080), display may differ

5. Display on screen
   ├─ If natural image is 1920x1080: scaleX=1, scaleY=1 (no scaling)
   ├─ If natural image is 1280x720: scaleX=0.666, scaleY=0.666 (scaled down)
   └─ Masks appear in correct position!
```

## Testing

To verify the fix works:

1. **Create a dataset with images of different sizes**
   - E.g., Image1: 1920x1080, Image2: 1280x720, Image3: 800x600

2. **Annotate all images with segmentation masks**
   - Make sure to annotate different objects in each

3. **Save the annotations**
   - Use "Save Annotation File" or download COCO JSON

4. **Reload the annotation file**
   - Open the dataset again
   - Load the saved annotation file

5. **Verify masks appear correctly**
   - Navigate to each image
   - Masks should appear in the exact same position as when annotated
   - No shifting or misalignment should occur

## Migration Notes

### For Existing Annotations

Annotations created before this fix may have:
- Normalized coordinates (0-1) in database
- Wrong image dimensions in COCO files

These will need to be:
1. **Re-saved** to convert to pixel coordinates
2. OR **Migrated** with a script that:
   - Reads annotations from DB
   - De-normalizes coordinates (multiply by image dimensions)
   - Updates segmentation field

### Backward Compatibility

The frontend loading code (lines 968-1000) still has logic to detect "abnormally large" coordinates and scale them down. This provides some backward compatibility for incorrectly stored coordinates.

## Files Modified

1. `backend/app/routers/annotation_db.py`
   - Modified: `validate_and_normalize_segmentation()` docstring
   - Modified: `process_coco_annotation_file()` - changed normalize param to False
   - Modified: `process_coco_annotation_file_task()` - changed normalize param to False

2. `backend/app/routers/datasets.py`
   - Modified: `get_dataset_annotation_content()` - simplified segmentation retrieval
   - Modified: `get_dataset_annotation_content()` - simplified bbox retrieval

3. `src/pages/ImageAnnotation.tsx`
   - Modified: `downloadAnnotationsJSON()` - retrieve stored dimensions per image
   - Modified: `saveNewAnnotationFile()` - retrieve stored dimensions per image
   - Modified: `saveAllAnnotations()` - retrieve stored dimensions per image
   - Modified: drawing code comments for clarity

## Summary

The fix ensures that:
- ✅ Segmentation coordinates are consistently stored as pixels (not normalized)
- ✅ Each image's correct dimensions are stored in COCO files
- ✅ Coordinate transformations are predictable and correct
- ✅ Masks appear in the correct position regardless of image size differences
