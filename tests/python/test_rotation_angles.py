import geopandas as gpd
import rasterio
import json
from shapely.geometry import mapping
import argparse
from rasterio.transform import Affine
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import math

def geo_to_pixel_coords(transform, x, y, width, height, rotation_degrees=0):
    """Convert geographic coordinates to pixel coordinates with optional rotation"""
    inv_transform = ~transform
    px, py = inv_transform * (x, y)
    
    # Flip only X coordinate for image coordinate system
    px = width - px
    
    # Apply rotation around image center if specified
    if rotation_degrees != 0:
        cx, cy = width / 2, height / 2
        # Translate to origin
        px_centered = px - cx
        py_centered = py - cy
        # Rotate
        angle_rad = math.radians(rotation_degrees)
        px_rotated = px_centered * math.cos(angle_rad) - py_centered * math.sin(angle_rad)
        py_rotated = px_centered * math.sin(angle_rad) + py_centered * math.cos(angle_rad)
        # Translate back
        px = px_rotated + cx
        py = py_rotated + cy
    
    return px, py

def run_rotation_angle_demo(image_path, transform_path, shapefile_path, output_dir, target_crs="EPSG:32635"):
    # Load shapefile
    gdf = gpd.read_file(shapefile_path)
    print(f"Shapefile CRS: {gdf.crs}")
    
    if str(gdf.crs) != target_crs:
        print(f"Converting shapefile from {gdf.crs} to {target_crs}")
        gdf = gdf.to_crs(target_crs)
    
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
    
    # Convert to PIL Image
    if img_array.shape[0] >= 3:
        img_rgb = np.dstack([img_array[0], img_array[1], img_array[2]])
    else:
        img_rgb = np.dstack([img_array[0], img_array[0], img_array[0]])
    
    if img_rgb.max() > 255:
        img_rgb = ((img_rgb - img_rgb.min()) / (img_rgb.max() - img_rgb.min()) * 255).astype(np.uint8)
    else:
        img_rgb = img_rgb.astype(np.uint8)
    
    base_img = Image.fromarray(img_rgb)
    
    # Test different rotation angles
    test_angles = [0, 5, 10, 15, 20, 25, 30, 45, 60, 75, 90, -5, -10, -15, -20, -25, -30, -45, -60, -75, -90]
    
    import os
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"\nTesting {len(test_angles)} rotation angles...")
    
    for angle in test_angles:
        pil_img = base_img.copy()
        draw = ImageDraw.Draw(pil_img)
        
        # Process first polygon
        for idx, row in gdf.iterrows():
            geom = row.geometry
            if geom.geom_type != "Polygon":
                continue
            
            coords = list(mapping(geom)["coordinates"][0])
            pixel_coords = [geo_to_pixel_coords(transform, x, y, width, height, angle) for x, y in coords]
            
            # Check if within bounds
            x_vals, y_vals = zip(*pixel_coords)
            if max(x_vals) < -10 or min(x_vals) > width + 10 or max(y_vals) < -10 or min(y_vals) > height + 10:
                continue
            
            # Draw polygon in RED
            draw.polygon(pixel_coords, outline=(255, 0, 0), width=3)
            
            # Draw first point as GREEN circle
            first_px, first_py = pixel_coords[0]
            circle_radius = 8
            draw.ellipse(
                [(first_px - circle_radius, first_py - circle_radius),
                 (first_px + circle_radius, first_py + circle_radius)],
                fill=(0, 255, 0), outline=(0, 255, 0)
            )
            
            break  # Only first annotation
        
        # Add angle label
        draw.text((10, 10), f"Rotation: {angle}°", fill=(255, 255, 0))
        
        # Save
        output_path = os.path.join(output_dir, f"rotation_{angle:+04d}.png")
        pil_img.save(output_path)
        print(f"  Saved: rotation_{angle:+04d}.png")
    
    print(f"\n✅ Done! Check images in: {output_dir}")
    print(f"   Look for the image where the RED polygon matches the object best")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test different rotation angles")
    parser.add_argument("--image", required=True, help="Path to image file")
    parser.add_argument("--transform", required=True, help="Path to transform JSON")
    parser.add_argument("--shapefile", required=True, help="Path to shapefile")
    parser.add_argument("--output", required=True, help="Output directory for test images")
    parser.add_argument("--crs", default="EPSG:32635", help="Target CRS")
    
    args = parser.parse_args()
    run_rotation_angle_demo(args.image, args.transform, args.shapefile, args.output, args.crs)
