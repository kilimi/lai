import geopandas as gpd
import rasterio
import json
from shapely.geometry import mapping
import os
import argparse
from rasterio.transform import Affine
from datetime import datetime

def geo_to_pixel_coords(transform, x, y):
    inv_transform = ~transform
    return inv_transform * (x, y)

def shapefile_to_coco_for_crop(shapefile_path, transform_path, image_path, output_json, category_name="object"):
    gdf = gpd.read_file(shapefile_path)

    with open(transform_path, "r") as f:
        t = json.load(f)
    transform = Affine(t["a"], t["b"], t["c"], t["d"], t["e"], t["f"])

    with rasterio.open(image_path) as src:
        width, height = src.width, src.height

    coco = {
        "info": {
            "description": "All annotations for dataset 1",
            "version": "1.0",
            "year": 2025,
            "date_created": datetime.now().isoformat() + "Z"
        },
        "images": [{
            "id": 1,
            "file_name": os.path.basename(image_path),
            "width": width,
            "height": height
        }],
        "annotations": [],
        "categories": [{"id": 1, "name": category_name}]
    }

    for idx, row in gdf.iterrows():
        geom = row.geometry
        if geom.geom_type != "Polygon":
            continue

        coords = list(mapping(geom)["coordinates"][0])
        pixel_coords = [geo_to_pixel_coords(transform, x, y) for x, y in coords]
        segmentation = [coord for xy in pixel_coords for coord in xy]

        x_vals, y_vals = zip(*pixel_coords)
        bbox = [min(x_vals), min(y_vals), max(x_vals) - min(x_vals), max(y_vals) - min(y_vals)]

        coco["annotations"].append({
            "id": idx,
            "image_id": 1,
            "category_id": 1,
            "segmentation": [segmentation],
            "bbox": bbox,
            "area": bbox[2] * bbox[3],
            "iscrowd": 0
        })

    with open(output_json, "w") as f:
        json.dump(coco, f, indent=2)

    print(f"✅ COCO annotations saved to {output_json}")

# === Argument Parser ===
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert geospatial annotations to COCO format for cropped image")
    parser.add_argument("--shapefile", required=True, help="Path to geospatial annotation shapefile")
    parser.add_argument("--transform", required=True, help="Path to transform.json for cropped image")
    parser.add_argument("--image", required=True, help="Path to cropped image (e.g., shape_#.tif)")
    parser.add_argument("--out", required=True, help="Path to output COCO JSON file")
    parser.add_argument("--category", default="object", help="Annotation category name")

    args = parser.parse_args()
    shapefile_to_coco_for_crop(args.shapefile, args.transform, args.image, args.out, args.category)