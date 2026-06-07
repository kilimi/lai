import geopandas as gpd
import rasterio
import json
from shapely.geometry import mapping, box, Polygon
import os
import argparse
from rasterio.transform import Affine
from datetime import datetime
from pathlib import Path
from tqdm import tqdm

def geo_to_pixel_coords(transform, x, y, width, height):
    """Convert geographic coordinates to pixel coordinates using affine transform"""
    inv_transform = ~transform
    px, py = inv_transform * (x, y)
    return px, py

def get_image_bounds_in_geo(image_path, transform):
    """Get the geographic bounds of a cropped image"""
    with rasterio.open(image_path) as src:
        width, height = src.width, src.height
    
    # Get corner coordinates in pixel space
    corners_pixel = [(0, 0), (width, 0), (width, height), (0, height)]
    
    # Convert to geographic coordinates
    corners_geo = [transform * (px, py) for px, py in corners_pixel]
    xs, ys = zip(*corners_geo)
    
    return box(min(xs), min(ys), max(xs), max(ys))

def polygon_intersects_image(polygon, image_bounds):
    """Check if a polygon intersects with the image bounds"""
    return polygon.intersects(image_bounds)

def clip_polygon_to_image(polygon, image_bounds):
    """Clip a polygon to image bounds"""
    try:
        clipped = polygon.intersection(image_bounds)
        if clipped.is_empty:
            return None
        return clipped
    except:
        return None

def process_cropped_images(shapefile_path, images_folder, transforms_folder, output_file, 
                          category_name="object", image_pattern="*.png", class_column=None, filter_class=None,
                          manual_class_name=None, target_crs=None, min_visible_ratio=0.05):
    """
    Process all cropped images and match them with shapefile annotations.
    
    Args:
        shapefile_path: Path to shapefile with annotations on full orthomosaic
        images_folder: Folder containing cropped images
        transforms_folder: Folder containing transform.json files for each image
        output_file: Output file path for COCO JSON file
        category_name: Default category name if no class column specified
        image_pattern: Pattern to match image files (e.g., "*.tif", "*.png")
        class_column: Column name in shapefile for class labels (optional)
        filter_class: Only process annotations with this class name (requires class_column)
        manual_class_name: Override all annotations with this class name (ignores class_column)
        target_crs: Target CRS to use (e.g., "EPSG:32635"). If None, uses shapefile CRS
        min_visible_ratio: Minimum ratio of annotation area that must be visible (default: 0.05 = 5%)
    """
    
    # Create output directory if it doesn't exist
    output_path = Path(output_file)
    os.makedirs(output_path.parent, exist_ok=True)
    
    # Load shapefile
    print(f"📂 Loading shapefile: {shapefile_path}")
    gdf = gpd.read_file(shapefile_path)
    print(f"   Found {len(gdf)} annotations in shapefile")
    print(f"   Shapefile CRS: {gdf.crs}")
    
    # Convert to target CRS if specified
    if target_crs:
        print(f"   Converting shapefile to {target_crs}")
        gdf = gdf.to_crs(target_crs)
    
    # Filter by class if specified
    if filter_class and class_column and class_column in gdf.columns:
        original_count = len(gdf)
        gdf = gdf[gdf[class_column] == filter_class]
        print(f"   Filtered to {len(gdf)} annotations with class '{filter_class}' (from {original_count})")
    
    # Get unique categories
    if manual_class_name:
        # Use manually specified class name for all annotations
        categories = [{"id": 1, "name": manual_class_name}]
        class_to_id = {manual_class_name: 1}
        print(f"   Using manual class name: '{manual_class_name}' for all annotations")
    elif class_column and class_column in gdf.columns:
        unique_classes = sorted(gdf[class_column].unique())
        categories = [{"id": i+1, "name": str(cls)} for i, cls in enumerate(unique_classes)]
        class_to_id = {str(cls): i+1 for i, cls in enumerate(unique_classes)}
        print(f"   Found {len(categories)} classes: {[c['name'] for c in categories]}")
    else:
        categories = [{"id": 1, "name": category_name}]
        class_to_id = {category_name: 1}
        print(f"   Using single category: {category_name}")
        print(f"   Using single category: {category_name}")
    
    # Find all image files
    images_path = Path(images_folder)
    image_files = list(images_path.glob(image_pattern))
    print(f"\n📁 Found {len(image_files)} images in {images_folder}")
    
    if len(image_files) == 0:
        print(f"⚠️  No images found matching pattern '{image_pattern}'")
        return
    
    # Process each image
    total_annotations = 0
    processed_images = 0
    skipped_images = 0
    
    # Debug: Check first few image bounds
    debug_mode = True
    debug_count = 0
    
    # Initialize global COCO structure for all images
    global_coco = {
        "info": {
            "year": 2025,
            "version": "1.0",
            "description": "VIA project exported to COCO format using VGG Image Annotator (http://www.robots.ox.ac.uk/~vgg/software/via/)",
            "contributor": "",
            "url": "http://www.robots.ox.ac.uk/~vgg/software/via/",
            "date_created": datetime.now().strftime("%a %b %d %Y %H:%M:%S GMT%z")
        },
        "images": [],
        "annotations": [],
        "licenses": [{"id": 0, "name": "Unknown License", "url": ""}],
        "categories": categories
    }
    
    global_image_id = 1
    global_annotation_id = 1
    
    for image_path in tqdm(image_files, desc="Processing images"):
        image_name = image_path.stem
        transform_path = Path(transforms_folder) / f"{image_name}_transform.json"
        
        # Check if transform file exists
        if not transform_path.exists():
            print(f"⚠️  Transform not found for {image_name}, skipping...")
            skipped_images += 1
            continue
        
        try:
            # Load transform
            with open(transform_path, "r") as f:
                t = json.load(f)
            
            # Handle different transform formats
            if isinstance(t, list) and len(t) >= 6:
                # Format: [a, b, c, d, e, f]
                transform = Affine(t[0], t[1], t[2], t[3], t[4], t[5])
            elif isinstance(t, dict):
                # Format with nested transform: {"transform": {"a": ..., "b": ..., ...}}
                if "transform" in t and isinstance(t["transform"], dict):
                    tr = t["transform"]
                    if all(k in tr for k in ["a", "b", "c", "d", "e", "f"]):
                        # Use transform as-is from rasterio
                        transform = Affine(tr["a"], tr["b"], tr["c"], tr["d"], tr["e"], tr["f"])
                        
                        # Debug: print transform to verify
                        if debug_mode and debug_count < 3:
                            print(f"   📐 Transform matrix from file:")
                            print(f"      a={tr['a']}, b={tr['b']}, c={tr['c']}")
                            print(f"      d={tr['d']}, e={tr['e']}, f={tr['f']}")
                    else:
                        raise ValueError(f"Transform dictionary missing required keys. Found: {list(tr.keys())}")
                # Format: {"a": ..., "b": ..., ...}
                elif all(k in t for k in ["a", "b", "c", "d", "e", "f"]):
                    transform = Affine(t["a"], t["b"], t["c"], t["d"], t["e"], t["f"])
                    
                    # Debug: print transform to verify
                    if debug_mode and debug_count < 3:
                        print(f"   📐 Transform matrix from file:")
                        print(f"      a={t['a']}, b={t['b']}, c={t['c']}")
                        print(f"      d={t['d']}, e={t['e']}, f={t['f']}")
                # Alternative format: {"transform": [a, b, c, d, e, f]}
                elif "transform" in t and isinstance(t["transform"], list) and len(t["transform"]) >= 6:
                    tr = t["transform"]
                    transform = Affine(tr[0], tr[1], tr[2], tr[3], tr[4], tr[5])
                else:
                    raise ValueError(f"Transform dictionary missing required keys or format. Found: {list(t.keys())}")
            else:
                raise ValueError(f"Unsupported transform format. Expected dict or list, got: {type(t)}")
            
            # Get image dimensions
            with rasterio.open(str(image_path)) as src:
                width, height = src.width, src.height
            
            # Get image bounds in geographic coordinates
            image_bounds = get_image_bounds_in_geo(str(image_path), transform)
            
                # Debug first few images
            if debug_mode and debug_count < 3:
                print(f"\n🔍 Debug for {image_name}:")
                print(f"   Image bounds (geo): {image_bounds.bounds}")
                print(f"   Image size (pixels): {width}x{height}")
                print(f"   Transform: a={transform.a:.6f}, e={transform.e:.6f}")
                print(f"   Transform origin: c={transform.c:.2f}, f={transform.f:.2f}")
                print(f"   Transform CRS: {t.get('crs', 'Not specified in transform file')}")
                print(f"   Shapefile CRS: {gdf.crs}")
                print(f"\n   Transform interpretation:")
                print(f"     Pixel (0, 0) → geo ({transform.c:.2f}, {transform.f:.2f})")
                print(f"     Pixel ({width}, 0) → geo ({transform.c + width*transform.a:.2f}, {transform.f:.2f})")
                print(f"     Pixel (0, {height}) → geo ({transform.c:.2f}, {transform.f + height*transform.e:.2f})")
                print(f"     Pixel ({width}, {height}) → geo ({transform.c + width*transform.a:.2f}, {transform.f + height*transform.e:.2f})")
                if len(gdf) > 0:
                    first_geom = gdf.iloc[0].geometry
                    print(f"\n   First annotation bounds (geo): {first_geom.bounds}")
                    # Check if bounds are in same general area
                    img_center_x = (image_bounds.bounds[0] + image_bounds.bounds[2]) / 2
                    img_center_y = (image_bounds.bounds[1] + image_bounds.bounds[3]) / 2
                    ann_center_x = (first_geom.bounds[0] + first_geom.bounds[2]) / 2
                    ann_center_y = (first_geom.bounds[1] + first_geom.bounds[3]) / 2
                    print(f"   Image center (geo): ({img_center_x:.2f}, {img_center_y:.2f})")
                    print(f"   Annotation center (geo): ({ann_center_x:.2f}, {ann_center_y:.2f})")
                debug_count += 1
            
            # Special debug for patch_265
            if "patch_265" in image_name.lower():
                print(f"\n⚠️ Special debug for {image_name}:")
                print(f"   Transform params: a={transform.a}, b={transform.b}, c={transform.c}")
                print(f"                     d={transform.d}, e={transform.e}, f={transform.f}")
                print(f"   Image bounds: {image_bounds.bounds}")            # Track starting annotation count for this image
            starting_annotation_count = global_annotation_id
            annotations_added_this_image = 0
            
            # Find annotations that intersect with this image
            intersecting_count = 0
            
            for idx, row in gdf.iterrows():
                geom = row.geometry
                
                # Skip non-polygon geometries
                if geom.geom_type != "Polygon":
                    continue
                
                # Check if polygon intersects with image bounds in GEOGRAPHIC space first
                if not polygon_intersects_image(geom, image_bounds):
                    continue
                
                # Clip polygon to image bounds in GEOGRAPHIC space to get proper intersection
                clipped_geom = clip_polygon_to_image(geom, image_bounds)
                if clipped_geom is None or clipped_geom.is_empty:
                    continue
                
                # Handle MultiPolygon result from clipping
                if clipped_geom.geom_type == "MultiPolygon":
                    polygons_to_process = list(clipped_geom.geoms)
                else:
                    polygons_to_process = [clipped_geom]
                
                for poly in polygons_to_process:
                    if poly.geom_type != "Polygon":
                        continue
                    
                    # Check visible area ratio before processing
                    original_area = geom.area
                    clipped_area = poly.area
                    visible_ratio = clipped_area / original_area if original_area > 0 else 0
                    
                    # Skip if less than minimum visible ratio
                    if visible_ratio < min_visible_ratio:
                        continue
                    
                    # Get coordinates from CLIPPED polygon (this is the intersection shape)
                    coords = list(mapping(poly)["coordinates"][0])
                    
                    # Convert clipped coordinates to pixel space
                    pixel_coords = [geo_to_pixel_coords(transform, x, y, width, height) for x, y in coords]
                    
                    # Check if ANY part of polygon is visible
                    x_vals, y_vals = zip(*pixel_coords)
                    
                    # Skip if completely outside image
                    if max(x_vals) < 0 or min(x_vals) > width or max(y_vals) < 0 or min(y_vals) > height:
                        continue
                
                    # Debug: Show coordinates for debugging
                    if debug_mode and debug_count <= 3:
                        print(f"   ⚠️ Found polygon with coords: X range=({min(x_vals):.1f}, {max(x_vals):.1f}), Y range=({min(y_vals):.1f}, {max(y_vals):.1f})")
                    
                    # Create segmentation - flatten coordinates from pixel coords
                    segmentation = [coord for xy in pixel_coords for coord in xy]
                    segmentation = [segmentation]  # COCO format expects array of polygons
                    
                    # Calculate bbox from pixel coords
                    bbox = [
                        min(x_vals), 
                        min(y_vals), 
                        max(x_vals) - min(x_vals), 
                        max(y_vals) - min(y_vals)
                    ]
                
                # Skip very small annotations
                if bbox[2] < 1 or bbox[3] < 1:
                    continue
                
                # Calculate area
                area = bbox[2] * bbox[3]
                
                # Get category ID
                if manual_class_name:
                    cat_id = 1  # Always use ID 1 for manual class name
                elif class_column and class_column in row:
                    cat_id = class_to_id.get(str(row[class_column]), 1)
                else:
                    cat_id = 1
                
                # Add annotation to global COCO structure
                global_coco["annotations"].append({
                    "id": global_annotation_id,
                    "image_id": global_image_id,
                    "category_id": cat_id,
                    "segmentation": segmentation,
                    "bbox": bbox,
                    "area": area,
                    "iscrowd": 0
                })
                
                # Debug first annotation
                if debug_mode and debug_count <= 3 and annotations_added_this_image == 0:
                    print(f"   First annotation in this image:")
                    print(f"     Geo coords (first point): {coords[0]}")
                    print(f"     Pixel coords (first point): ({pixel_coords[0][0]:.2f}, {pixel_coords[0][1]:.2f})")
                    print(f"     Bbox: [{bbox[0]:.2f}, {bbox[1]:.2f}, {bbox[2]:.2f}, {bbox[3]:.2f}]")
                    # Test reverse transform
                    test_px, test_py = pixel_coords[0]
                    test_geo_x, test_geo_y = transform * (test_px, test_py)
                    print(f"     Reverse check: pixel ({test_px:.2f}, {test_py:.2f}) → geo ({test_geo_x:.2f}, {test_geo_y:.2f})")
                    print(f"     Should match: {coords[0]}")
                    print(f"     Match difference: ({abs(test_geo_x - coords[0][0]):.4f}, {abs(test_geo_y - coords[0][1]):.4f})")
                
                global_annotation_id += 1
                annotations_added_this_image += 1
            
            intersecting_count = annotations_added_this_image
            
            # Debug: Show intersecting count for first few images
            #if debug_mode and debug_count <= 3:
            #    print(f"   Intersecting annotations: {intersecting_count}")
            
            # Only add image to COCO structure if it has annotations
            if intersecting_count > 0:
                global_coco["images"].append({
                    "id": global_image_id,
                    "file_name": image_path.name,
                    "width": width,
                    "height": height,
                    "license": 0,
                    "date_captured": ""
                })
                total_annotations += intersecting_count
                processed_images += 1
                global_image_id += 1
            else:
                # No annotations for this image, reset annotation counter to starting point
                # (annotations were not actually added since intersecting_count is 0)
                pass
            
        except Exception as e:
            print(f"\n❌ Error processing {image_name}: {str(e)}")
            if "transform" in str(e).lower():
                print(f"   Transform file content: {transform_path}")
                try:
                    with open(transform_path, "r") as f:
                        content = json.load(f)
                    print(f"   Transform format: {type(content)}")
                    if isinstance(content, dict):
                        print(f"   Keys: {list(content.keys())}")
                    elif isinstance(content, list):
                        print(f"   Length: {len(content)}")
                except:
                    pass
            skipped_images += 1
            continue
    
    # Save the combined COCO JSON file
    with open(output_file, "w") as f:
        json.dump(global_coco, f, indent=2)
    
    # Print summary
    print(f"\n{'='*60}")
    print(f"✅ Processing complete!")
    print(f"{'='*60}")
    print(f"   Total images: {len(image_files)}")
    print(f"   Images with annotations: {processed_images}")
    print(f"   Images skipped: {skipped_images}")
    print(f"   Total annotations created: {total_annotations}")
    print(f"   Output file: {output_file}")
    print(f"{'='*60}")

# === Argument Parser ===
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Match shapefile annotations to cropped images and generate COCO JSON files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic usage with single category
  python match_shapefile_to_crops.py \\
    --shapefile annotations.shp \\
    --images ./cropped_images \\
    --transforms ./transforms \\
    --output annotations.json

  # With class column and custom pattern
  python match_shapefile_to_crops.py \\
    --shapefile annotations.shp \\
    --images ./cropped_images \\
    --transforms ./transforms \\
    --output ./output/annotations.json \\
    --class-column "class_name" \\
    --pattern "*.png"

  # Filter by specific class name
  python match_shapefile_to_crops.py \\
    --shapefile annotations.shp \\
    --images ./cropped_images \\
    --transforms ./transforms \\
    --output ./output/trees.json \\
    --class-column "class_name" \\
    --filter-class "tree"

  # Use manual class name for all annotations
  python match_shapefile_to_crops.py \\
    --shapefile annotations.shp \\
    --images ./cropped_images \\
    --transforms ./transforms \\
    --output ./output/buildings.json \\
    --manual-class "building"
        """
    )
    
    parser.add_argument("--shapefile", required=True, 
                       help="Path to shapefile with annotations on full orthomosaic")
    parser.add_argument("--images", required=True, 
                       help="Folder containing cropped images")
    parser.add_argument("--transforms", required=True, 
                       help="Folder containing transform JSON files")
    parser.add_argument("--output", required=True, 
                       help="Output file path for COCO JSON file (e.g., annotations.json)")
    parser.add_argument("--category", default="object", 
                       help="Default category name (default: 'object')")
    parser.add_argument("--pattern", default="*.tif", 
                       help="Image file pattern (default: '*.tif')")
    parser.add_argument("--class-column", default=None, 
                       help="Column name in shapefile for class labels (optional)")
    parser.add_argument("--filter-class", default=None, 
                       help="Only process annotations with this class name (requires --class-column)")
    parser.add_argument("--manual-class", default=None, 
                       help="Manually set class name for all annotations (overrides --class-column)")
    parser.add_argument("--crs", default=None, 
                       help="Target CRS (e.g., EPSG:32635). If not specified, uses shapefile CRS")
    parser.add_argument("--min-visible-ratio", type=float, default=0.05, 
                       help="Minimum ratio of annotation area that must be visible (default: 0.05 = 5%%)")

    args = parser.parse_args()
    
    process_cropped_images(
        shapefile_path=args.shapefile,
        images_folder=args.images,
        transforms_folder=args.transforms,
        output_file=args.output,
        category_name=args.category,
        image_pattern=args.pattern,
        class_column=args.class_column,
        filter_class=args.filter_class,
        manual_class_name=args.manual_class,
        target_crs=args.crs,
        min_visible_ratio=args.min_visible_ratio
    )
