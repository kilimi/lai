import rasterio
from rasterio.mask import mask
import geopandas as gpd
import pandas as pd
import os
from PIL import Image, ImageDraw
import numpy as np
import argparse
import json
from shapely.geometry import mapping, box
import random
from tqdm import tqdm

def geo_to_pixel_coords(transform, x, y, width, height):
    """Convert geographic coordinates to pixel coordinates using affine transform"""
    from rasterio.transform import Affine
    inv_transform = ~transform
    px, py = inv_transform * (x, y)
    return px, py

def get_crop_bounds_in_geo(transform, width, height):
    """Get the geographic bounds of the cropped image"""
    corners_pixel = [(0, 0), (width, 0), (width, height), (0, height)]
    corners_geo = [transform * (px, py) for px, py in corners_pixel]
    xs, ys = zip(*corners_geo)
    return box(min(xs), min(ys), max(xs), max(ys))

def draw_test_annotation(image_path, coco_data, output_path):
    """Draw annotations on image for visual verification"""
    try:
        # Load image
        img = Image.open(image_path)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        draw = ImageDraw.Draw(img)
        
        # Draw each annotation
        for ann in coco_data["annotations"]:
            # Get segmentation coordinates
            seg = ann["segmentation"][0]
            # Convert to list of tuples
            coords = [(seg[i], seg[i+1]) for i in range(0, len(seg), 2)]
            
            # Draw polygon in RED
            if len(coords) > 2:
                draw.polygon(coords, outline=(255, 0, 0), width=3)
            
            # Draw first point as GREEN circle
            if len(coords) > 0:
                first_x, first_y = coords[0]
                radius = 10
                draw.ellipse(
                    [(first_x - radius, first_y - radius),
                     (first_x + radius, first_y + radius)],
                    fill=(0, 255, 0), outline=(0, 255, 0)
                )
        
        img.save(output_path, 'PNG')
        return True
    except Exception as e:
        return False

def process_annotations_for_crop(annotation_gdf, shape_id, output_dir, transform, width, height,
                                 class_column=None, manual_class_name=None, target_crs=None, image_id=1, annotation_start_id=1, categories_dict=None):
    """Process annotations for a single crop and return annotation data"""
    # Convert annotations to target CRS if needed
    if target_crs and annotation_gdf.crs != target_crs:
        annotations = annotation_gdf.to_crs(target_crs)
    else:
        annotations = annotation_gdf
    
    # Get crop bounds in geographic coordinates
    crop_bounds = get_crop_bounds_in_geo(transform, width, height)
    
    # Find intersecting annotations
    intersecting = annotations[annotations.intersects(crop_bounds)]
    
    if len(intersecting) == 0:
        return None, annotation_start_id, categories_dict
    
    # Build image info
    image_info = {
        "id": image_id,
        "width": width,
        "height": height,
        "file_name": f"{shape_id}.png"
    }
    
    # Initialize categories dict if not provided
    if categories_dict is None:
        categories_dict = {}
    
    # Get or create categories
    if manual_class_name:
        if manual_class_name not in categories_dict:
            categories_dict[manual_class_name] = len(categories_dict) + 1
    elif class_column and class_column in intersecting.columns:
        # Get unique class values, filtering out None/NaN/empty values
        unique_classes = intersecting[class_column].dropna().unique()
        for cls in unique_classes:
            cls_str = str(cls).strip()
            if cls_str and cls_str not in categories_dict:
                categories_dict[cls_str] = len(categories_dict) + 1
        # Add default "object" category if no valid classes found
        if len(categories_dict) == 0:
            categories_dict["object"] = 1
    else:
        if "object" not in categories_dict:
            categories_dict["object"] = 1
    
    annotations_list = []
    annotation_id = annotation_start_id
    
    for idx, row in intersecting.iterrows():
        geom = row.geometry
        
        if geom.geom_type != "Polygon":
            continue
        
        # Clip polygon to crop bounds
        clipped_geom = geom.intersection(crop_bounds)
        if clipped_geom.is_empty:
            continue
        
        # Handle MultiPolygon
        polygons_to_process = list(clipped_geom.geoms) if clipped_geom.geom_type == "MultiPolygon" else [clipped_geom]
        
        for poly in polygons_to_process:
            if poly.geom_type != "Polygon":
                continue
            
            # Get coordinates and convert to pixel space
            coords = list(mapping(poly)["coordinates"][0])
            pixel_coords = [geo_to_pixel_coords(transform, x, y, width, height) for x, y in coords]
            
            # Check if visible
            x_vals, y_vals = zip(*pixel_coords)
            if max(x_vals) < 0 or min(x_vals) > width or max(y_vals) < 0 or min(y_vals) > height:
                continue
            
            # Create segmentation
            segmentation = [coord for xy in pixel_coords for coord in xy]
            
            # Calculate bbox
            bbox = [min(x_vals), min(y_vals), max(x_vals) - min(x_vals), max(y_vals) - min(y_vals)]
            
            # Skip very small annotations
            if bbox[2] < 1 or bbox[3] < 1:
                continue
            
            # Get category ID
            if manual_class_name:
                cat_id = categories_dict[manual_class_name]
            elif class_column:
                # Try to get class name from the specified column
                try:
                    if class_column in row.index:
                        class_value = row[class_column]
                        # Handle None, NaN, or empty values
                        if pd.notna(class_value) and str(class_value).strip():
                            class_str = str(class_value).strip()
                            # Add the class to categories_dict if it doesn't exist
                            if class_str not in categories_dict:
                                categories_dict[class_str] = len(categories_dict) + 1
                            cat_id = categories_dict[class_str]
                        else:
                            # Use default category for empty/invalid values
                            if "object" not in categories_dict:
                                categories_dict["object"] = len(categories_dict) + 1
                            cat_id = categories_dict["object"]
                    else:
                        if "object" not in categories_dict:
                            categories_dict["object"] = len(categories_dict) + 1
                        cat_id = categories_dict["object"]
                except Exception as e:
                    print(f"Warning: Error reading class from column '{class_column}': {e}")
                    if "object" not in categories_dict:
                        categories_dict["object"] = len(categories_dict) + 1
                    cat_id = categories_dict["object"]
            else:
                if "object" not in categories_dict:
                    categories_dict["object"] = len(categories_dict) + 1
                cat_id = categories_dict["object"]
            
            # Add annotation
            annotations_list.append({
                "id": annotation_id,
                "image_id": image_id,
                "category_id": cat_id,
                "segmentation": [segmentation],
                "area": bbox[2] * bbox[3],
                "bbox": bbox,
                "iscrowd": 0
            })
            annotation_id += 1
    
    if len(annotations_list) > 0:
        return {"image": image_info, "annotations": annotations_list}, annotation_id, categories_dict
    else:
        return None, annotation_id, categories_dict

def detect_class_column(gdf):
    """Automatically detect the column name that likely contains class names"""
    # Common attribute names for class information
    common_names = ['class', 'classname', 'class_name', 'className', 'CLASS', 'CLASSNAME', 
                    'label', 'Label', 'LABEL', 'category', 'Category', 'CATEGORY',
                    'type', 'Type', 'TYPE', 'name', 'Name', 'NAME']
    
    # First try exact matches
    for col_name in common_names:
        if col_name in gdf.columns:
            return col_name
    
    # Then try case-insensitive partial matches
    for col in gdf.columns:
        col_lower = col.lower()
        if any(name.lower() in col_lower for name in ['class', 'label', 'category', 'type']):
            return col
    
    return None

def inspect_shapefile_attributes(shapefile_path):
    """Inspect and print shapefile attributes to help identify class columns"""
    gdf = gpd.read_file(shapefile_path)
    print(f"\n📋 Shapefile attributes for: {shapefile_path}")
    print(f"   Total features: {len(gdf)}")
    print(f"   Geometry type: {gdf.geometry.geom_type.unique()}")
    print(f"\n   Available columns:")
    
    for col in gdf.columns:
        if col != 'geometry':
            # Show column name, type, and sample values
            dtype = gdf[col].dtype
            unique_count = gdf[col].nunique()
            sample_values = gdf[col].unique()[:5]
            print(f"      - {col} ({dtype}): {unique_count} unique values")
            print(f"        Sample values: {list(sample_values)}")
    
    # Try to auto-detect class column
    detected_col = detect_class_column(gdf)
    if detected_col:
        print(f"\n   ✓ Auto-detected class column: '{detected_col}'")
        unique_classes = gdf[detected_col].unique()
        print(f"   Classes found: {list(unique_classes)}")
    else:
        print(f"\n   ⚠ No class column auto-detected. You may need to specify --annotation-class-column")
    
    return gdf, detected_col

def crop_and_save(orthomosaic_path, shapefile_path, output_dir, target_crs, save_bands,
                  annotation_shapefile=None, annotation_class_column=None, annotation_class_name=None, bgr_to_rgb=False, only_annotated=False):
    shapes = gpd.read_file(shapefile_path)
    shapes = shapes.to_crs(target_crs)
    
    # Load annotation shapefile if provided
    annotation_gdf = None
    crops_with_annotations = []  # Track which crops have annotations
    all_images = []
    all_annotations = []
    categories_dict = {}
    annotation_id_counter = 1
    image_id_counter = 1
    
    if annotation_shapefile:
        # Inspect shapefile and auto-detect class column if not specified
        annotation_gdf, detected_class_col = inspect_shapefile_attributes(annotation_shapefile)
        
        # Use detected column if no column was manually specified
        if annotation_class_column is None and detected_class_col is not None:
            annotation_class_column = detected_class_col
            print(f"\n✓ Using auto-detected class column: '{annotation_class_column}'")
        elif annotation_class_column:
            print(f"\n✓ Using manually specified class column: '{annotation_class_column}'")
            # Verify the column exists
            if annotation_class_column not in annotation_gdf.columns:
                print(f"\n⚠ Warning: Column '{annotation_class_column}' not found in shapefile!")
                print(f"   Available columns: {list(annotation_gdf.columns)}")
                annotation_class_column = None
        else:
            print(f"\n⚠ No class column specified or detected. Using default class name.")

    with rasterio.open(orthomosaic_path) as src:
        shapes = shapes.to_crs(src.crs)
        os.makedirs(output_dir, exist_ok=True)

        for idx, row in tqdm(shapes.iterrows(), total=len(shapes), desc="Processing patches", unit="patch"):
            geometry = [row['geometry']]
            out_image, out_transform = mask(src, geometry, crop=True)

            # Use patch_{idx} naming
            patch_name = f"patch_{idx}"
            
            # Check if crop has any valid data before saving anything
            if np.ma.isMaskedArray(out_image):
                fill_value = src.nodata if src.nodata is not None else 0
                out_image = out_image.filled(fill_value)

            out_image = np.asarray(out_image)
            
            # Check if crop is empty (all zeros or nodata)
            has_data = False
            if out_image.shape[0] >= 3:
                for i in range(min(3, out_image.shape[0])):
                    band_data = out_image[i]
                    valid_data = band_data[np.isfinite(band_data)]
                    if len(valid_data) > 0 and valid_data.max() > 0:
                        has_data = True
                        break
            
            if not has_data:
                continue
            
            # Check if we should only save annotated images
            if only_annotated and annotation_gdf is not None:
                # Pre-check if this crop has any annotations
                crop_bounds = get_crop_bounds_in_geo(out_transform, out_image.shape[2], out_image.shape[1])
                if annotation_gdf.crs != src.crs:
                    temp_annotations = annotation_gdf.to_crs(src.crs)
                else:
                    temp_annotations = annotation_gdf
                intersecting = temp_annotations[temp_annotations.intersects(crop_bounds)]
                if len(intersecting) == 0:
                    continue
            
            # Save out_transform as JSON (nested under 'transform' key to match QGIS format)
            transform_path = os.path.join(output_dir, f"{patch_name}_transform.json")
            transform_data = {
                "transform": {
                    "a": out_transform.a,
                    "b": out_transform.b,
                    "c": out_transform.c,
                    "d": out_transform.d,
                    "e": out_transform.e,
                    "f": out_transform.f
                }
            }
            with open(transform_path, "w") as f:
                json.dump(transform_data, f, indent=2)

            out_meta = src.meta.copy()
            out_meta.update({
                "driver": "GTiff",
                "height": out_image.shape[1],
                "width": out_image.shape[2],
                "transform": out_transform,
                "count": out_image.shape[0],
            })

            out_meta["dtype"] = out_image.dtype
            if src.nodata is not None:
                out_meta["nodata"] = src.nodata

            out_meta.setdefault("compress", "lzw")

            def normalize_and_save(band_data, file_path):
                """Convert band data to PNG using percentile stretching."""
                # Handle masked arrays and invalid data
                if np.ma.isMaskedArray(band_data):
                    band_data = band_data.filled(0)
                
                valid_data = band_data[np.isfinite(band_data)]
                
                if len(valid_data) == 0:
                    normalized_data = np.zeros_like(band_data, dtype=np.uint8)
                else:
                    # Use percentile stretch for robust normalization
                    p2, p98 = np.percentile(valid_data, (2, 98))
                    
                    # Avoid division by zero
                    if p98 == p2:
                        normalized_data = np.full_like(band_data, 128, dtype=np.uint8)
                    else:
                        stretched = np.clip((band_data - p2) / (p98 - p2), 0, 1)
                        normalized_data = (stretched * 255).astype(np.uint8)
                
                img = Image.fromarray(normalized_data)
                img.save(file_path, 'PNG')

            # Save each band as a separate PNG only if --bands flag is set
            if save_bands:
                for i in range(out_image.shape[0]):
                    band_path = os.path.join(output_dir, f"{patch_name}_band_{i+1}.png")
                    normalize_and_save(out_image[i], band_path)

            # Always create RGB composite if we have at least 3 bands
            if out_image.shape[0] >= 3:
                # Debug: Check band statistics
                #print(f"Band statistics for {patch_name}:")
                for i in range(min(3, out_image.shape[0])):
                    band_data = out_image[i]
                    valid_data = band_data[np.isfinite(band_data)]
                    #if len(valid_data) > 0:
                        #band_min, band_max, band_mean = valid_data.min(), valid_data.max(), valid_data.mean()
                        #print(f"  Band {i+1}: min={band_min:.2f}, max={band_max:.2f}, mean={band_mean:.2f}")
                    #else:
                        #print(f"  Band {i+1}: No valid data")
                
                # Use robust normalization for each RGB channel
                def robust_normalize_channel(band_data):
                    """Normalize a single band using percentile stretching."""
                    # Handle masked arrays
                    if np.ma.isMaskedArray(band_data):
                        band_data = band_data.filled(0)
                    
                    valid_data = band_data[np.isfinite(band_data)]
                    
                    if len(valid_data) == 0:
                        return np.zeros_like(band_data, dtype=np.uint8)
                    
                    # Use percentile stretch to avoid extreme values
                    p2, p98 = np.percentile(valid_data, (2, 98))
                    
                    # Avoid division by zero
                    if p98 == p2:
                        return np.full_like(band_data, 128, dtype=np.uint8)
                    
                    stretched = np.clip((band_data - p2) / (p98 - p2), 0, 1)
                    return (stretched * 255).astype(np.uint8)
                
                # Handle BGR to RGB conversion if needed
                if bgr_to_rgb:
                    # Swap channels: BGR -> RGB (band 0=Blue, band 1=Green, band 2=Red)
                    r_norm = robust_normalize_channel(out_image[2])  # Red from band 2
                    g_norm = robust_normalize_channel(out_image[1])  # Green from band 1
                    b_norm = robust_normalize_channel(out_image[0])  # Blue from band 0
                else:
                    # Normal RGB order
                    r_norm = robust_normalize_channel(out_image[0])
                    g_norm = robust_normalize_channel(out_image[1])
                    b_norm = robust_normalize_channel(out_image[2])
                
                # Check if all channels are identical
                #if np.array_equal(r_norm, g_norm) and np.array_equal(g_norm, b_norm):
                #    print(f"⚠️  Warning: All RGB channels are identical for {patch_name}")
                
                rgb_array = np.stack([r_norm, g_norm, b_norm], axis=-1)
                rgb_path = os.path.join(output_dir, f"{patch_name}.png")
                Image.fromarray(rgb_array).save(rgb_path, 'PNG')
            
            # Process annotations if annotation shapefile provided
            if annotation_gdf is not None:
                result, annotation_id_counter, categories_dict = process_annotations_for_crop(
                    annotation_gdf, patch_name, output_dir, 
                    out_transform, out_image.shape[2], out_image.shape[1],
                    annotation_class_column, annotation_class_name, src.crs,
                    image_id_counter, annotation_id_counter, categories_dict
                )
                if result is not None:  # Has annotations
                    all_images.append(result["image"])
                    all_annotations.extend(result["annotations"])
                    crops_with_annotations.append((patch_name, output_dir))
                    image_id_counter += 1
    
    # Save single COCO JSON file with all annotations
    if annotation_gdf is not None and len(all_annotations) > 0:
        # Print summary of processed annotations
        print(f"\n✓ Annotation Processing Summary:")
        print(f"   Total images with annotations: {len(all_images)}")
        print(f"   Total annotations: {len(all_annotations)}")
        print(f"   Classes found: {len(categories_dict)}")
        for cat_name, cat_id in sorted(categories_dict.items(), key=lambda x: x[1]):
            cat_count = sum(1 for ann in all_annotations if ann['category_id'] == cat_id)
            print(f"      - {cat_name} (ID: {cat_id}): {cat_count} annotations")
        
        coco_output = {
            "info": {
                "description": "Cropped orthomosaic annotations",
                "version": "1.0",
                "year": 2025
            },
            "images": all_images,
            "annotations": all_annotations,
            "categories": [{"id": cat_id, "name": cat_name, "supercategory": "object"} 
                          for cat_name, cat_id in sorted(categories_dict.items(), key=lambda x: x[1])]
        }
        
        coco_path = os.path.join(output_dir, "annotations.json")
        with open(coco_path, "w") as f:
            json.dump(coco_output, f, indent=2)
        print(f"\n✓ Annotations saved to: {coco_path}")
        
        # Print detailed statistics per class
        print(f"\n" + "="*60)
        print(f"📊 DETAILED STATISTICS PER CLASS")
        print(f"="*60)
        
        for cat_name, cat_id in sorted(categories_dict.items(), key=lambda x: x[1]):
            cat_annotations = [ann for ann in all_annotations if ann['category_id'] == cat_id]
            cat_count = len(cat_annotations)
            
            if cat_count > 0:
                # Calculate statistics
                areas = [ann['area'] for ann in cat_annotations]
                bbox_widths = [ann['bbox'][2] for ann in cat_annotations]
                bbox_heights = [ann['bbox'][3] for ann in cat_annotations]
                
                print(f"\n🏷️  Class: {cat_name} (ID: {cat_id})")
                print(f"   Total annotations: {cat_count}")
                print(f"   Area statistics:")
                print(f"      - Min area: {min(areas):.2f} px²")
                print(f"      - Max area: {max(areas):.2f} px²")
                print(f"      - Avg area: {sum(areas)/len(areas):.2f} px²")
                print(f"   Bounding box statistics:")
                print(f"      - Width range: {min(bbox_widths):.2f} - {max(bbox_widths):.2f} px")
                print(f"      - Height range: {min(bbox_heights):.2f} - {max(bbox_heights):.2f} px")
                print(f"      - Avg dimensions: {sum(bbox_widths)/len(bbox_widths):.2f} x {sum(bbox_heights)/len(bbox_heights):.2f} px")
                
                # Count images containing this class
                images_with_class = len(set(ann['image_id'] for ann in cat_annotations))
                print(f"   Images containing this class: {images_with_class} / {len(all_images)}")
                print(f"   Avg annotations per image: {cat_count/images_with_class:.2f}")
        
        print(f"\n" + "="*60)
        print(f"📈 OVERALL SUMMARY")
        print(f"="*60)
        print(f"   Total classes: {len(categories_dict)}")
        print(f"   Total images: {len(all_images)}")
        print(f"   Total annotations: {len(all_annotations)}")
        print(f"   Avg annotations per image: {len(all_annotations)/len(all_images):.2f}")
        print(f"="*60 + "\n")
        
        # Create one random test visualization if we have crops with annotations
        if len(crops_with_annotations) > 0:
            test_crop = random.choice(crops_with_annotations)
            patch_name, output_dir_ref = test_crop
            
            # Find the image and its annotations
            test_image = next((img for img in all_images if img["file_name"] == f"{patch_name}.png"), None)
            if test_image:
                test_annotations = [ann for ann in all_annotations if ann["image_id"] == test_image["id"]]
                test_coco_data = {
                    "images": [test_image],
                    "annotations": test_annotations,
                    "categories": coco_output["categories"]
                }
                
                png_path = os.path.join(output_dir_ref, f"{patch_name}.png")
                if os.path.exists(png_path):
                    test_viz_path = os.path.join(output_dir_ref, f"{patch_name}_test_annotations.png")
                    draw_test_annotation(png_path, test_coco_data, test_viz_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Crop orthomosaic using shapefile and save bands as PNGs and GeoTIFFs.")
    parser.add_argument("-m", "--orthomosaic", required=True, help="Path to orthomosaic TIFF file")
    parser.add_argument("-s", "--shapefile", required=True, help="Path to shapefile with crop shapes")
    parser.add_argument("-o", "--output", required=True, help="Directory to save cropped images")
    parser.add_argument("--crs", default="EPSG:32635", help="Target CRS for shapefile (default: EPSG:32635)")
    parser.add_argument("--bands", action="store_true", help="Save individual bands as separate PNG files")
    parser.add_argument("--bgr", action="store_true", help="Convert BGR to RGB (use if ground appears purple)")
    parser.add_argument("-a", "--annotations", dest="annotation_shapefile", help="Path to annotation shapefile (optional)")
    parser.add_argument("--annotation-class-column", help="Column name in annotation shapefile for class labels")
    parser.add_argument("--annotation-class-name", help="Override all annotations with this class name")
    parser.add_argument("--only-annotated", action="store_true", help="Only save images that have annotations")

    args = parser.parse_args()
    crop_and_save(args.orthomosaic, args.shapefile, args.output, args.crs, args.bands,
                  args.annotation_shapefile, args.annotation_class_column, args.annotation_class_name, args.bgr, args.only_annotated)