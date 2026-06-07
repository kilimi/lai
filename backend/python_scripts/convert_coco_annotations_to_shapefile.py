import json
import argparse
import os
import rasterio
from shapely.geometry import mapping, Polygon
import fiona

# === Parse Command-Line Arguments ===
parser = argparse.ArgumentParser(description="Transform COCO segmentation annotations to geospatial Shapefile using orthomosaic.")
parser.add_argument("-i", "--images", required=True, help="Path to image folder")
parser.add_argument("-a", "--annotations", required=True, help="Path to COCO annotation JSON")
parser.add_argument("-o", "--orthomosaic", required=True, help="Path to orthomosaic GeoTIFF")
parser.add_argument("-s", "--shapefile", required=True, help="Path to output Shapefile")
args = parser.parse_args()

image_folder = args.images
annotation_json_path = args.annotations
orthomosaic_path = args.orthomosaic
output_shapefile = args.shapefile

# === Load COCO Annotations ===
with open(annotation_json_path) as f:
    coco = json.load(f)

images_by_id = {img["id"]: img for img in coco["images"]}

# === Open Orthomosaic ===
with rasterio.open(orthomosaic_path) as ortho:
    transform = ortho.transform
    crs = ortho.crs

    # === Setup Shapefile Schema ===
    schema = {
        'geometry': 'Polygon',
        'properties': {
            'image': 'str',
            'category': 'str',
            'id': 'int'
        }
    }

    with fiona.open(output_shapefile, 'w', driver='ESRI Shapefile',
                    crs=crs.to_string(), schema=schema) as shp:

        for ann in coco["annotations"]:
            image_info = images_by_id.get(ann["image_id"])
            if not image_info:
                continue

            filename = image_info["file_name"]

            # Skip if no segmentation
            if not ann.get("segmentation"):
                continue

            for seg in ann["segmentation"]:
                if len(seg) < 6:
                    continue  # Not a valid polygon

                coords = []
                for i in range(0, len(seg), 2):
                    x_px, y_px = seg[i], seg[i + 1]
                    x_geo, y_geo = transform * (x_px, y_px)
                    coords.append((x_geo, y_geo))

                # Ensure polygon is closed
                if coords[0] != coords[-1]:
                    coords.append(coords[0])

                polygon = Polygon(coords)

                # Skip invalid or degenerate polygons
                if not polygon.is_valid or polygon.area == 0:
                    continue

                shp.write({
                    'geometry': mapping(polygon),
                    'properties': {
                        'image': filename,
                        'category': str(ann["category_id"]),
                        'id': ann["id"]
                    }
                })

print(f"✅ Shapefile saved to: {output_shapefile}")