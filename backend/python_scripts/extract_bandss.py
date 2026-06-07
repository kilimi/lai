import os
import rasterio
from rasterio.features import shapes
import geopandas as gpd
from shapely.geometry import shape
import numpy as np

# --- CONFIG ---
input_raster = r"C:\Users\Lilita\Nextcloud\MDPI_paper\WR_stressed_clip_color_distance_kmeans.tif"   # path to your raster
output_dir = r"C:\Users\Lilita\Nextcloud\MDPI_paper\labels_polygons"      # folder to save shapefiles

# Optional: map pixel values to label names (customize as needed)
# If empty, will use pixel values as label names
label_names = {
    # 0: "background",
    # 1: "class_1",
    # 2: "class_2",
    # Add your label mappings here
}

# Set to True to create one shapefile per label, False for single shapefile with all labels
separate_shapefiles_per_label = True

os.makedirs(output_dir, exist_ok=True)

# --- STEP 1: Open raster ---
with rasterio.open(input_raster) as src:
    band_count = src.count
    profile = src.profile
    
    print(f"Raster has {band_count} bands")
    
    # Read the first (and only) band
    band = src.read(1)
    
    # Get unique values (labels) in the raster
    unique_values = np.unique(band)
    print(f"Found {len(unique_values)} unique label values: {unique_values}")

    # --- STEP 2: Polygonize the band ---
    results = list(
        {"properties": {"value": int(v)}, "geometry": s}
        for s, v in shapes(band.astype(np.int32), mask=None, transform=src.transform)
    )
    
    geoms = []
    values = []
    for r in results:
        geoms.append(shape(r["geometry"]))
        values.append(r["properties"]["value"])
    
    # Create GeoDataFrame with all polygons (use short column names for shapefile compatibility)
    gdf = gpd.GeoDataFrame({"value": values}, geometry=geoms, crs=src.crs)
    
    # Add label names if mapping provided
    if label_names:
        gdf["name"] = gdf["value"].map(label_names).fillna(gdf["value"].astype(str))
    else:
        gdf["name"] = gdf["value"].astype(str)
    
    print(f"Total polygons extracted: {len(gdf)}")

    # --- STEP 3: Save shapefiles ---
    if separate_shapefiles_per_label:
        # Save each label as a separate shapefile
        for label_val in unique_values:
            label_gdf = gdf[gdf["value"] == label_val].copy()
            
            # Get label name for filename
            if label_names and label_val in label_names:
                label_str = label_names[label_val]
            else:
                label_str = f"label_{int(label_val)}"
            
            out_shp = os.path.join(output_dir, f"{label_str}.shp")
            label_gdf.to_file(out_shp)
            print(f"Saved label {label_val} ({len(label_gdf)} polygons) to {out_shp}")
    else:
        # Save all labels in a single shapefile
        out_shp = os.path.join(output_dir, "all_labels.shp")
        gdf.to_file(out_shp)
        print(f"Saved all labels ({len(gdf)} polygons) to {out_shp}")