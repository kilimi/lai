"""
Image Slicer - Slices images into 1024x1024 tiles with 20% overlap
"""

import os
import math
from PIL import Image
from pathlib import Path


def slice_image(image_path, output_dir, tile_size=1024, overlap=0.2):
    """
    Slice an image into tiles of specified size with overlap.
    
    Args:
        image_path: Path to the input image
        output_dir: Directory to save the sliced tiles
        tile_size: Size of each tile (default: 1024x1024)
        overlap: Overlap percentage between tiles (default: 0.2 = 20%)
    
    Returns:
        List of saved tile paths
    """
    # Open the image
    img = Image.open(image_path)
    img_width, img_height = img.size
    
    # Calculate step size (stride) based on overlap
    step_size = int(tile_size * (1 - overlap))
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Get base filename without extension
    base_name = Path(image_path).stem
    extension = Path(image_path).suffix
    
    saved_tiles = []
    tile_count = 0
    
    # Calculate number of tiles in each direction
    num_tiles_x = math.ceil((img_width - tile_size) / step_size) + 1
    num_tiles_y = math.ceil((img_height - tile_size) / step_size) + 1
    
    print(f"Image size: {img_width}x{img_height}")
    print(f"Tile size: {tile_size}x{tile_size}")
    print(f"Step size (with {overlap*100}% overlap): {step_size}")
    print(f"Expected tiles: {num_tiles_x} x {num_tiles_y} = {num_tiles_x * num_tiles_y}")
    
    for row in range(num_tiles_y):
        for col in range(num_tiles_x):
            # Calculate tile coordinates
            x = col * step_size
            y = row * step_size
            
            # Adjust if tile goes beyond image boundaries
            if x + tile_size > img_width:
                x = img_width - tile_size
            if y + tile_size > img_height:
                y = img_height - tile_size
            
            # Ensure coordinates are not negative
            x = max(0, x)
            y = max(0, y)
            
            # Crop the tile
            tile = img.crop((x, y, x + tile_size, y + tile_size))
            
            # Save the tile
            tile_filename = f"{base_name}_tile_{row}_{col}{extension}"
            tile_path = os.path.join(output_dir, tile_filename)
            tile.save(tile_path)
            
            saved_tiles.append({
                "path": tile_path,
                "x": x,
                "y": y,
                "row": row,
                "col": col
            })
            tile_count += 1
    
    print(f"Saved {tile_count} tiles to {output_dir}")
    return saved_tiles


def slice_images_in_directory(input_dir, output_dir, tile_size=1024, overlap=0.2):
    """
    Slice all images in a directory.
    
    Args:
        input_dir: Directory containing input images
        output_dir: Directory to save the sliced tiles
        tile_size: Size of each tile (default: 1024x1024)
        overlap: Overlap percentage between tiles (default: 0.2 = 20%)
    """
    # Supported image extensions
    image_extensions = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'}
    
    # Find all images in input directory
    input_path = Path(input_dir)
    images = [f for f in input_path.iterdir() if f.suffix.lower() in image_extensions]
    
    print(f"Found {len(images)} images to process")
    
    all_tiles = []
    for image_path in images:
        print(f"\nProcessing: {image_path.name}")
        # Create subdirectory for each image's tiles
        image_output_dir = os.path.join(output_dir, image_path.stem)
        tiles = slice_image(str(image_path), image_output_dir, tile_size, overlap)
        all_tiles.extend(tiles)
    
    print(f"\nTotal tiles created: {len(all_tiles)}")
    return all_tiles


if __name__ == "__main__":
    # Example usage
    import argparse
    
    parser = argparse.ArgumentParser(description="Slice images into tiles with overlap")
    parser.add_argument("input", help="Input image or directory")
    parser.add_argument("output", help="Output directory for tiles")
    parser.add_argument("--tile-size", type=int, default=1024, help="Tile size (default: 1024)")
    parser.add_argument("--overlap", type=float, default=0.2, help="Overlap percentage (default: 0.2)")
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    
    if input_path.is_file():
        # Single image
        slice_image(args.input, args.output, args.tile_size, args.overlap)
    elif input_path.is_dir():
        # Directory of images
        slice_images_in_directory(args.input, args.output, args.tile_size, args.overlap)
    else:
        print(f"Error: {args.input} is not a valid file or directory")
