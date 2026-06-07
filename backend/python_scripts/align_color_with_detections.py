#!/usr/bin/env python3
"""
Script to merge two COCO annotation files by finding overlapping annotations
and creating merged annotations labeled as 'WR_stressed'.

Usage:
    python align_color_with_detections.py <file1.json> <file2.json> <output.json>
"""

import json
import sys
from pathlib import Path
from typing import List, Dict, Tuple, Any
from shapely.geometry import Polygon
from shapely.ops import unary_union


def load_coco_file(filepath: str) -> Dict:
    """Load a COCO format JSON file."""
    with open(filepath, 'r') as f:
        return json.load(f)


def save_coco_file(data: Dict, filepath: str):
    """Save data to a COCO format JSON file."""
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)


def polygon_from_segmentation(segmentation: List) -> Polygon:
    """
    Convert COCO segmentation to Shapely Polygon.
    
    Args:
        segmentation: COCO segmentation (list of [x1,y1,x2,y2,...] or list of such lists)
    
    Returns:
        Shapely Polygon object
    """
    if not segmentation:
        return Polygon()
    
    # Handle both [[x1,y1,x2,y2,...]] and [x1,y1,x2,y2,...] formats
    if isinstance(segmentation[0], list):
        points = segmentation[0]
    else:
        points = segmentation
    
    # Convert flat list to list of coordinate tuples
    coords = [(points[i], points[i+1]) for i in range(0, len(points), 2)]
    
    try:
        return Polygon(coords)
    except:
        return Polygon()


def polygon_from_bbox(bbox: List[float]) -> Polygon:
    """
    Convert COCO bbox [x, y, width, height] to Shapely Polygon.
    
    Args:
        bbox: COCO bounding box [x, y, width, height]
    
    Returns:
        Shapely Polygon object
    """
    x, y, w, h = bbox
    return Polygon([
        (x, y),
        (x + w, y),
        (x + w, y + h),
        (x, y + h)
    ])


def annotation_to_polygon(annotation: Dict) -> Polygon:
    """Convert a COCO annotation to a Shapely Polygon."""
    if 'segmentation' in annotation and annotation['segmentation']:
        poly = polygon_from_segmentation(annotation['segmentation'])
        if not poly.is_empty:
            # Buffer by 0 to fix any self-intersections or invalid geometries
            if not poly.is_valid:
                poly = poly.buffer(0)
            return poly
    
    if 'bbox' in annotation:
        return polygon_from_bbox(annotation['bbox'])
    
    return Polygon()


def polygon_to_segmentation(polygon: Polygon) -> List[float]:
    """Convert a Shapely Polygon to COCO segmentation format."""
    from shapely.geometry import MultiPolygon
    
    if polygon.is_empty:
        return []
    
    # Handle MultiPolygon by taking the largest polygon
    if isinstance(polygon, MultiPolygon):
        # Get the largest polygon by area
        polygon = max(polygon.geoms, key=lambda p: p.area)
    
    coords = list(polygon.exterior.coords[:-1])  # Exclude last point (same as first)
    # Round coordinates to avoid floating point precision issues
    flat_coords = [round(coord, 2) for point in coords for coord in point]
    return flat_coords


def polygon_to_bbox(polygon: Polygon) -> List[float]:
    """Convert a Shapely Polygon to COCO bbox format [x, y, width, height]."""
    from shapely.geometry import MultiPolygon
    
    if polygon.is_empty:
        return [0, 0, 0, 0]
    
    # Handle MultiPolygon by taking the largest polygon
    if isinstance(polygon, MultiPolygon):
        polygon = max(polygon.geoms, key=lambda p: p.area)
    
    minx, miny, maxx, maxy = polygon.bounds
    # Round to avoid floating point precision issues
    return [round(minx, 2), round(miny, 2), round(maxx - minx, 2), round(maxy - miny, 2)]


def calculate_area(polygon: Polygon) -> float:
    """Calculate the area of a polygon."""
    from shapely.geometry import MultiPolygon
    
    if polygon.is_empty:
        return 0.0
    
    # MultiPolygon already has area calculation that sums all parts
    return round(polygon.area, 2)


def find_overlapping_annotations(
    annotations1: List[Dict],
    annotations2: List[Dict],
    image_id1: int,
    image_id2: int,
    iou_threshold: float = 0.01
) -> List[Tuple[Dict, Dict, Polygon]]:
    """
    Find pairs of overlapping annotations from two lists.
    
    Args:
        annotations1: List of annotations from first file
        annotations2: List of annotations from second file
        image_id1: Image ID in first file
        image_id2: Image ID in second file
        iou_threshold: Minimum IoU to consider as overlap
    
    Returns:
        List of tuples (ann1, ann2, merged_polygon)
    """
    # Filter annotations for this image
    anns1 = [a for a in annotations1 if a['image_id'] == image_id1]
    anns2 = [a for a in annotations2 if a['image_id'] == image_id2]
    
    print(f"  Image (id1={image_id1}, id2={image_id2}): {len(anns1)} annotations in file1, {len(anns2)} annotations in file2")
    
    overlaps = []
    
    for i, ann1 in enumerate(anns1):
        poly1 = annotation_to_polygon(ann1)
        if poly1.is_empty:
            print(f"    Warning: Empty polygon for ann1 id={ann1.get('id', 'unknown')}")
            continue
        
        for j, ann2 in enumerate(anns2):
            poly2 = annotation_to_polygon(ann2)
            if poly2.is_empty:
                print(f"    Warning: Empty polygon for ann2 id={ann2.get('id', 'unknown')}")
                continue
            
            # Check if polygons intersect
            if poly1.intersects(poly2):
                intersection = poly1.intersection(poly2)
                
                # Calculate IoU
                union_area = poly1.area + poly2.area - intersection.area
                iou = intersection.area / union_area if union_area > 0 else 0
                
                print(f"    Found intersection: ann1[{i}] x ann2[{j}], IoU={iou:.4f}, intersection_area={intersection.area:.2f}")
                
                if iou >= iou_threshold:
                    # Merge the polygons using union with error handling
                    try:
                        merged = poly1.union(poly2)
                        # Validate the merged polygon
                        if not merged.is_valid:
                            merged = merged.buffer(0)
                        
                        if merged.is_empty or merged.area < 1.0:
                            print(f"      -> Skipped: merged polygon is too small or empty")
                            continue
                            
                        overlaps.append((ann1, ann2, merged))
                        print(f"      -> Added to overlaps (passed IoU threshold)")
                    except Exception as e:
                        print(f"      -> Error merging polygons: {e}")
                        # Try using convex hull as fallback
                        try:
                            from shapely.ops import unary_union
                            merged = unary_union([poly1, poly2]).convex_hull
                            if not merged.is_empty and merged.area >= 1.0:
                                overlaps.append((ann1, ann2, merged))
                                print(f"      -> Added using convex hull fallback")
                            else:
                                print(f"      -> Skipped: convex hull too small")
                        except Exception as e2:
                            print(f"      -> Fallback also failed: {e2}")
                            continue
    
    return overlaps


def merge_coco_files(
    file1_path: str,
    file2_path: str,
    output_path: str,
    iou_threshold: float = 0.01
):
    """
    Merge two COCO annotation files by finding overlapping annotations.
    
    Args:
        file1_path: Path to first COCO file
        file2_path: Path to second COCO file
        output_path: Path to output merged COCO file
        iou_threshold: Minimum IoU to consider as overlap
    """
    print(f"Loading {file1_path}...")
    coco1 = load_coco_file(file1_path)
    
    print(f"Loading {file2_path}...")
    coco2 = load_coco_file(file2_path)
    
    # Create output structure based on first file
    output_coco = {
        'info': coco1.get('info', {}),
        'licenses': coco1.get('licenses', []),
        'images': coco1.get('images', []),
        'categories': [],
        'annotations': []
    }
    
    # Add or update the WR_stressed category
    wr_stressed_category = {
        'id': 1,
        'name': 'WR_stressed',
        'supercategory': 'object'
    }
    output_coco['categories'].append(wr_stressed_category)
    
    # Create mapping of image file names to IDs for both files
    image_map1 = {img['file_name']: img['id'] for img in coco1.get('images', [])}
    image_map2 = {img['file_name']: img['id'] for img in coco2.get('images', [])}
    
    # Find common images by file name
    common_images = set(image_map1.keys()) & set(image_map2.keys())
    
    print(f"File 1: {len(coco1.get('annotations', []))} total annotations")
    print(f"File 2: {len(coco2.get('annotations', []))} total annotations")
    print(f"File 1: {len(image_map1)} images")
    print(f"File 2: {len(image_map2)} images")
    print(f"Common images: {len(common_images)}")
    print(f"Processing {len(common_images)} common images...")
    
    annotation_id = 1
    total_merged = 0
    
    for file_name in common_images:
        image_id1 = image_map1[file_name]
        image_id2 = image_map2[file_name]
        
        # Find overlapping annotations for this image
        overlaps = find_overlapping_annotations(
            coco1.get('annotations', []),
            coco2.get('annotations', []),
            image_id1,
            image_id2,
            iou_threshold
        )
        
        # Create merged annotations
        for ann1, ann2, merged_polygon in overlaps:
            if merged_polygon.is_empty:
                continue
            
            # Use the image_id from file1 (the output uses file1's images)
            output_image_id = image_id1
            
            # Create new annotation with merged polygon
            new_annotation = {
                'id': annotation_id,
                'image_id': output_image_id,
                'category_id': 1,  # WR_stressed category
                'segmentation': [polygon_to_segmentation(merged_polygon)],
                'bbox': polygon_to_bbox(merged_polygon),
                'area': calculate_area(merged_polygon),
                'iscrowd': 0
            }
            
            output_coco['annotations'].append(new_annotation)
            annotation_id += 1
            total_merged += 1
    
    print(f"Created {total_merged} merged annotations")
    print(f"Saving to {output_path}...")
    save_coco_file(output_coco, output_path)
    print("Done!")


def main():
    """Main entry point for the script."""
    if len(sys.argv) < 4:
        print("Usage: python align_color_with_detections.py <file1.json> <file2.json> <output.json>")
        print("\nMerges overlapping annotations from two COCO files into a new file")
        print("with annotations labeled as 'WR_stressed'")
        sys.exit(1)
    
    file1_path = sys.argv[1]
    file2_path = sys.argv[2]
    output_path = sys.argv[3]
    
    # Validate input files exist
    if not Path(file1_path).exists():
        print(f"Error: File not found: {file1_path}")
        sys.exit(1)
    
    if not Path(file2_path).exists():
        print(f"Error: File not found: {file2_path}")
        sys.exit(1)
    
    try:
        merge_coco_files(file1_path, file2_path, output_path)
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
