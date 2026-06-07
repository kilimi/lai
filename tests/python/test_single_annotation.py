import geopandas as gpd
import rasterio
import json
from shapely.geometry import mapping, box
import argparse
from rasterio.transform import Affine
from PIL import Image, ImageDraw
import numpy as np

def geo_to_pixel_coords(transform, x, y, width, height):
    """Convert geographic coordinates to pixel coordinates using affine transform"""
    inv_transform = ~transform
    px, py = inv_transform * (x, y)
    # Flip only X to match image coordinate system
    px = width - px
    return px, py

def get_image_bounds_in_geo(transform, width, height):
    """Get the geographic bounds of the image"""
    # Get corners in pixel coordinates
    corners_px = [
        (0, 0),
        (width, 0),
        (width, height),
        (0, height)
    ]
    
    # Convert to geographic coordinates
    corners_geo = [transform * corner for corner in corners_px]
    
    # Get min/max
    xs, ys = zip(*corners_geo)
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    
    return box(minx, miny, maxx, maxy)

def clip_polygon_to_image(polygon, image_bounds):
    """Clip polygon to image bounds"""
    try:
        clipped = polygon.intersection(image_bounds)
        return clipped
    except Exception as e:
        print(f"Error clipping polygon: {e}")
        return None

def draw_annotation_on_image(image_path, transform_path, shapefile_path, output_path, target_crs="EPSG:32635"):
    # Load shapefile
    gdf = gpd.read_file(shapefile_path)
    print(f"Shapefile CRS: {gdf.crs}")
    
    # Convert to target CRS if needed
    if str(gdf.crs) != target_crs:
        print(f"Converting shapefile from {gdf.crs} to {target_crs}")
        gdf = gdf.to_crs(target_crs)
    else:
        print(f"Shapefile already in {target_crs}")
    
    # Load transform
    with open(transform_path, "r") as f:
        t = json.load(f)
    
    if "transform" in t and isinstance(t["transform"], dict):
        tr = t["transform"]
        transform = Affine(tr["a"], tr["b"], tr["c"], tr["d"], tr["e"], tr["f"])
    else:
        transform = Affine(t["a"], t["b"], t["c"], t["d"], t["e"], t["f"])
    
    # Load image
    with rasterio.open(image_path) as src:
        img_array = src.read()
        width, height = src.width, src.height
    
    # Convert to PIL Image (assuming RGB)
    if img_array.shape[0] >= 3:
        img_rgb = np.dstack([img_array[0], img_array[1], img_array[2]])
    else:
        img_rgb = np.dstack([img_array[0], img_array[0], img_array[0]])
    
    # Normalize to 0-255 if needed
    if img_rgb.max() > 255:
        img_rgb = ((img_rgb - img_rgb.min()) / (img_rgb.max() - img_rgb.min()) * 255).astype(np.uint8)
    else:
        img_rgb = img_rgb.astype(np.uint8)
    
    pil_img = Image.fromarray(img_rgb)
    draw = ImageDraw.Draw(pil_img)
    
    print(f"Image size: {width}x{height}")
    print(f"Transform: a={transform.a}, b={transform.b}, c={transform.c}")
    print(f"           d={transform.d}, e={transform.e}, f={transform.f}")
    
    # Get image bounds in geographic coordinates
    image_bounds = get_image_bounds_in_geo(transform, width, height)
    print(f"\nImage bounds (geographic):")
    print(f"  minx: {image_bounds.bounds[0]:.2f}, miny: {image_bounds.bounds[1]:.2f}")
    print(f"  maxx: {image_bounds.bounds[2]:.2f}, maxy: {image_bounds.bounds[3]:.2f}")
    
    # Process first polygon only
    annotation_count = 0
    for idx, row in gdf.iterrows():
        geom = row.geometry
        
        if geom.geom_type != "Polygon":
            continue
        
        # Get all coordinates from original polygon
        coords = list(mapping(geom)["coordinates"][0])
        
        print(f"\nAnnotation {annotation_count + 1}:")
        print(f"  Original polygon has {len(coords)} points")
        print(f"  Geo coords (first 3 points):")
        for i, (x, y) in enumerate(coords[:3]):
            print(f"    Point {i+1}: ({x:.2f}, {y:.2f})")
        
        # Check which points are inside image bounds
        inside_count = 0
        for x, y in coords:
            if (image_bounds.bounds[0] <= x <= image_bounds.bounds[2] and 
                image_bounds.bounds[1] <= y <= image_bounds.bounds[3]):
                inside_count += 1
        print(f"  Points inside image bounds: {inside_count}/{len(coords)}")
        
        # Clip polygon to image bounds in GEOGRAPHIC space to get proper intersection
        clipped_geom = clip_polygon_to_image(geom, image_bounds)
        if clipped_geom is None or clipped_geom.is_empty:
            print(f"  ❌ Clipped polygon is empty")
            continue
        
        print(f"  Clipped polygon type: {clipped_geom.geom_type}")
        
        # Handle MultiPolygon result from clipping
        if clipped_geom.geom_type == "MultiPolygon":
            polygons_to_process = list(clipped_geom.geoms)
            print(f"  Clipping resulted in {len(polygons_to_process)} polygons")
        else:
            polygons_to_process = [clipped_geom]
        
        for part_idx, poly in enumerate(polygons_to_process):
            if poly.geom_type != "Polygon":
                continue
            
            # Get coordinates from CLIPPED polygon (this is the intersection shape)
            clipped_coords = list(mapping(poly)["coordinates"][0])
            print(f"  Clipped polygon has {len(clipped_coords)} points")
            print(f"  Clipped geo coords (first 3 points):")
            for i, (x, y) in enumerate(clipped_coords[:3]):
                print(f"    Point {i+1}: ({x:.2f}, {y:.2f})")
            
            # Convert clipped coordinates to pixel space
            pixel_coords = [geo_to_pixel_coords(transform, x, y, width, height) for x, y in clipped_coords]
            
            x_vals, y_vals = zip(*pixel_coords)
            print(f"  Pixel coords (first 3 points):")
            for i, (px, py) in enumerate(pixel_coords[:3]):
                print(f"    Point {i+1}: ({px:.2f}, {py:.2f})")
            print(f"  X range: ({min(x_vals):.1f}, {max(x_vals):.1f})")
            print(f"  Y range: ({min(y_vals):.1f}, {max(y_vals):.1f})")
            
            # Draw polygon in RED
            draw.polygon(pixel_coords, outline=(255, 0, 0), width=3)
            
            # Draw first point as a large circle
            first_px, first_py = pixel_coords[0]
            circle_radius = 10
            draw.ellipse(
                [(first_px - circle_radius, first_py - circle_radius),
                 (first_px + circle_radius, first_py + circle_radius)],
                fill=(0, 255, 0), outline=(0, 255, 0)
            )
            
            print(f"  ✅ Drew annotation (RED polygon, GREEN dot = first point)")
            annotation_count += 1
        
        if annotation_count >= 3:  # Draw max 3 annotations
            break
    
    # Save result
    pil_img.save(output_path)
    print(f"\n💾 Saved annotated image to: {output_path}")
    print(f"   Total annotations drawn: {annotation_count}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Draw annotations on image for visual verification")
    parser.add_argument("--image", required=True, help="Path to image file (PNG or TIF)")
    parser.add_argument("--transform", required=True, help="Path to transform JSON file")
    parser.add_argument("--shapefile", required=True, help="Path to shapefile with annotations")
    parser.add_argument("--output", required=True, help="Output path for annotated image (PNG)")
    parser.add_argument("--crs", default="EPSG:32635", help="Target CRS (default: EPSG:32635)")
    
    args = parser.parse_args()
    
    draw_annotation_on_image(args.image, args.transform, args.shapefile, args.output, args.crs)
