"""Dataset domain services (extracted from datasets router)."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import BackgroundTasks, HTTPException, UploadFile
from PIL import Image
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.database import SessionLocal
from app.services.dataset_media_service import set_random_image_as_logo
from app.services.dataset_video_service import video_progress_get, video_progress_set

logger = logging.getLogger(__name__)


async def upload_dataset_images(db: Session, dataset_id: int, files: List[UploadFile], base_url: str) -> dict:
    try:
        # Add debug logging
        print(f"DEBUG: Upload request received for dataset {dataset_id} with {len(files)} files")
        
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        
        # Use projects/{project_id}/{dataset_id}/images/ directory structure
        project_id = dataset.project_id
        dataset_dir = Path("projects") / str(project_id) / str(dataset_id) / "images"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        
        uploaded_images = []
        
        for file in files:
            # Check if file is an image by MIME type or file extension (for TIF files)
            clean_filename = os.path.basename(file.filename or "")
            is_image_mime = file.content_type and file.content_type.startswith('image/')
            is_tiff_file = clean_filename.lower().endswith(('.tif', '.tiff'))
            
            if not (is_image_mime or is_tiff_file):
                continue
            
            # Get or create default collection for this dataset (we need it for naming)
            default_collection = db.query(models.ImageCollection).filter(
                models.ImageCollection.dataset_id == dataset_id,
                models.ImageCollection.is_default == True
            ).first()
            
            if not default_collection:
                # Create default collection if it doesn't exist
                default_collection = models.ImageCollection(
                    dataset_id=dataset_id,
                    name="RGB Images",
                    description="Default image collection",
                    is_default=True
                )
                db.add(default_collection)
                db.flush()  # Get the ID without committing the full transaction
            
            # Check if file already exists on disk (across all collections) and generate unique filename
            original_path = dataset_dir / clean_filename
            final_filename = clean_filename
            counter = 1
            
            # Generate unique filename if file already exists on disk
            # Include collection name for better identification
            while original_path.exists():
                name, ext = os.path.splitext(clean_filename)
                if counter == 1:
                    # First conflict: use collection name
                    final_filename = f"{name}_{default_collection.name.replace(' ', '_')}{ext}"
                else:
                    # Subsequent conflicts: use collection name + number
                    final_filename = f"{name}_{default_collection.name.replace(' ', '_')}_{counter}{ext}"
                original_path = dataset_dir / final_filename
                counter += 1
            
            file_path = original_path
            
            try:
                contents = await file.read()
                
                # Extract image dimensions using Pillow
                width, height = 0, 0
                is_tiff_file = final_filename.lower().endswith(('.tif', '.tiff'))

                try:
                    img = Image.open(io.BytesIO(contents))
                    width, height = img.size
                    
                    # Handle multi-channel TIF images by converting to 3-channel PNG
                    if is_tiff_file and (img.mode not in ['RGB', 'L', 'P']): # L for grayscale, P for palette
                        print(f"DEBUG: Converting multi-channel TIF image: {final_filename}, mode: {img.mode}")
                        
                        if img.mode == 'RGBA' or img.mode == 'CMYK':
                            img = img.convert('RGB')
                        else:
                            # For other multi-band images, assume first 3 bands are R, G, B
                            bands = img.split()
                            if len(bands) >= 3:
                                img = Image.merge('RGB', (bands[0], bands[1], bands[2]))
                            else:
                                # Not enough bands to create RGB, maybe it's grayscale with alpha
                                img = img.convert('RGB') # Fallback

                        # Change filename to png and ensure it's unique
                        name, _ = os.path.splitext(final_filename)
                        png_filename = f"{name}.png"
                        
                        png_path = dataset_dir / png_filename
                        counter = 1
                        while png_path.exists():
                            png_filename = f"{name}_{counter}.png"
                            png_path = dataset_dir / png_filename
                            counter += 1
                        
                        final_filename = png_filename
                        file_path = png_path
                        
                        # Save as PNG
                        img_byte_arr = io.BytesIO()
                        img.save(img_byte_arr, format='PNG')
                        contents = img_byte_arr.getvalue()

                except Exception as img_error:
                    print(f"Warning: PIL failed for {final_filename}: {img_error}")
                    
                    # Fallback to OpenCV for problematic TIF files
                    if is_tiff_file:
                        try:
                            print(f"DEBUG: Trying OpenCV for {final_filename}")
                            # Save temp file for OpenCV to read
                            temp_path = dataset_dir / f"temp_{uuid.uuid4().hex[:8]}.tif"
                            with open(temp_path, 'wb') as temp_file:
                                temp_file.write(contents)
                            
                            # Read with OpenCV
                            cv_img = cv2.imread(str(temp_path), cv2.IMREAD_UNCHANGED)
                            
                            if cv_img is not None:
                                height, width = cv_img.shape[:2]
                                print(f"DEBUG: OpenCV read image with shape: {cv_img.shape}")
                                
                                # Convert multi-channel to RGB for multispectral imagery
                                if len(cv_img.shape) == 3:
                                    channels = cv_img.shape[2]
                                    print(f"DEBUG: Image has {channels} channels, dtype: {cv_img.dtype}")
                                    
                                    if channels == 4:
                                        # For DJI Mavic 3M: channels are Green, Red, Red Edge, NIR
                                        # Use NIR channel (channel 3) as grayscale for best visualization
                                        print("DEBUG: Processing DJI Mavic 3M multispectral image - using NIR channel")
                                        
                                        # Extract NIR channel (most informative for vegetation)
                                        nir_ch = cv_img[:, :, 3]     # Near Infrared channel
                                        
                                        # Normalize NIR channel to 0-255 range
                                        if nir_ch.dtype != np.uint8:
                                            nir_ch = nir_ch.astype(np.float64)
                                            ch_min, ch_max = nir_ch.min(), nir_ch.max()
                                            print(f"DEBUG: NIR channel range: {ch_min} to {ch_max}")
                                            
                                            # Handle signed data - clip negative values for NIR
                                            if ch_min < 0:
                                                print("DEBUG: Clipping negative NIR values (likely nodata)")
                                                nir_ch = np.clip(nir_ch, 0, None)  # Remove negative values
                                                ch_min = nir_ch.min()
                                                ch_max = nir_ch.max()
                                                print(f"DEBUG: After clipping negatives: {ch_min} to {ch_max}")
                                            
                                            # Apply percentile stretch for better contrast
                                            p2, p98 = np.percentile(nir_ch[nir_ch > 0], [2, 98])
                                            print(f"DEBUG: Using percentile stretch: {p2} to {p98}")
                                            nir_ch = np.clip(nir_ch, p2, p98)
                                            
                                            # Normalize to 0-255
                                            if p98 > p2:
                                                nir_ch = (nir_ch - p2) / (p98 - p2) * 255
                                            nir_ch = np.clip(nir_ch, 0, 255).astype(np.uint8)
                                        
                                        # Convert grayscale NIR to RGB for display
                                        cv_img = cv2.cvtColor(nir_ch, cv2.COLOR_GRAY2RGB)
                                        print(f"DEBUG: Created NIR grayscale RGB shape: {cv_img.shape}")
                                        
                                    elif channels > 4:
                                        # For other multi-channel images, take first 3 channels
                                        cv_img_rgb = cv_img[:, :, :3]
                                        
                                        # Normalize to 0-255 range if needed
                                        if cv_img_rgb.dtype != np.uint8:
                                            cv_img_rgb = cv_img_rgb.astype(np.float64)
                                            cv_img_rgb = (cv_img_rgb - cv_img_rgb.min()) / (cv_img_rgb.max() - cv_img_rgb.min()) * 255
                                            cv_img_rgb = cv_img_rgb.astype(np.uint8)
                                        
                                        # OpenCV uses BGR, we need RGB for PIL
                                        cv_img = cv2.cvtColor(cv_img_rgb, cv2.COLOR_BGR2RGB)
                                    elif channels == 3:
                                        # Standard BGR to RGB
                                        cv_img = cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB)
                                    elif channels == 1:
                                        # Grayscale to RGB
                                        cv_img = cv2.cvtColor(cv_img, cv2.COLOR_GRAY2RGB)
                                else:
                                    # Grayscale image
                                    cv_img = cv2.cvtColor(cv_img, cv2.COLOR_GRAY2RGB)
                                
                                # Convert to PNG
                                name, _ = os.path.splitext(final_filename)
                                png_filename = f"{name}.png"
                                
                                png_path = dataset_dir / png_filename
                                counter = 1
                                while png_path.exists():
                                    png_filename = f"{name}_{counter}.png"
                                    png_path = dataset_dir / png_filename
                                    counter += 1
                                
                                final_filename = png_filename
                                file_path = png_path
                                
                                # Save as PNG using OpenCV
                                cv2.imwrite(str(file_path), cv2.cvtColor(cv_img, cv2.COLOR_RGB2BGR))
                                
                                # Read the saved PNG file content for database storage
                                with open(file_path, 'rb') as png_file:
                                    contents = png_file.read()
                                
                                print(f"DEBUG: Successfully converted TIF to PNG: {final_filename} ({width}x{height})")
                            
                            # Clean up temp file
                            if temp_path.exists():
                                os.remove(temp_path)
                                
                        except Exception as cv_error:
                            print(f"Warning: OpenCV also failed for {final_filename}: {cv_error}")
                            # Clean up temp file in case of error
                            if 'temp_path' in locals() and temp_path.exists():
                                os.remove(temp_path)
                
                # Write the file with unique name
                with open(file_path, 'wb') as f:
                    f.write(contents)
                
                # Update URL to use the new structure with the final filename
                relative_url = f"/static/projects/{project_id}/{dataset_id}/images/{final_filename}"
                # Always create new image record since we generate unique filenames
                db_image = models.Image(
                    dataset_id=dataset_id,
                    collection_id=default_collection.id,  # Assign to default collection
                    file_name=final_filename,  # Use the unique filename
                    file_size=len(contents),
                    width=width,
                    height=height,
                    url=relative_url,
                    thumbnail_url=relative_url,
                    annotations_count=0
                )
                db.add(db_image)
                uploaded_images.append(db_image)
                print(f"Adding new image to default collection with unique name: {final_filename} ({width}x{height})")
                    
            except Exception as e:
                print(f"Error uploading file {file.filename}: {e}")
                continue
        
        # Update dataset image count (all images are new since we create unique filenames)
        current_image_count = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).count()
        dataset.image_count = current_image_count + len(uploaded_images)
        db.commit()
        
        # Set random image as logo if no logo is set
        set_random_image_as_logo(dataset, db, base_url)
        
        # Prepare response with uploaded images
        response_images = []
        
        for img in uploaded_images:
            url = f"{base_url}{img.url}" if img.url.startswith('/') else img.url
            thumbnail_url = f"{base_url}{img.thumbnail_url}?thumb=300" if img.thumbnail_url.startswith('/') else img.thumbnail_url
            response_images.append({
                "id": str(img.id),
                "datasetId": str(dataset_id),
                "fileName": img.file_name,
                "fileSize": img.file_size,
                "width": img.width,
                "height": img.height,
                "url": url,
                "thumbnailUrl": thumbnail_url,
                "uploadedAt": img.uploaded_at.isoformat(),
                "annotationsCount": img.annotations_count
            })
            
        return {
            "success": True,
            "data": {
                "uploaded": len(uploaded_images),
                "overwritten": 0,  # We no longer overwrite, always create unique filenames
                "images": response_images
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


def list_dataset_images(db: Session, dataset_id: int, base_url: str) -> dict:
    try:
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        images = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).all()
        response_images = []
        for img in images:
            url = img.url
            thumbnail_url = img.thumbnail_url
            if url and url.startswith('/'):
                url = f"{base_url}{url}"
            if thumbnail_url and thumbnail_url.startswith('/'):
                # Append ?thumb=300 for on-demand thumbnail generation
                thumbnail_url = f"{base_url}{thumbnail_url}?thumb=300"
            response_images.append({
                "id": str(img.id),
                "datasetId": str(dataset_id),
                "fileName": img.file_name,
                "fileSize": img.file_size,
                "width": img.width,
                "height": img.height,
                "url": url,
                "thumbnailUrl": thumbnail_url,
                "uploadedAt": img.uploaded_at.isoformat(),
                "annotationsCount": img.annotations_count
            })
        return {
            "success": True,
            "data": response_images
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def delete_dataset_image(db: Session, dataset_id: int, image_id: int) -> dict:
    try:
        # Find the image in the database
        image = db.query(models.Image).filter(
            models.Image.id == image_id,
            models.Image.dataset_id == dataset_id
        ).first()
        
        if not image:
            raise HTTPException(status_code=404, detail="Image not found")
        
        # Find the dataset to update the image count
        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found")
        
        # Try to delete the physical file from the new projects structure
        try:
            project_id = dataset.project_id
            dataset_dir = Path("projects") / str(project_id) / str(dataset_id) / "images"
            file_path = dataset_dir / image.file_name
            if file_path.exists():
                os.remove(file_path)
                print(f"Deleted physical file: {file_path}")
            else:
                print(f"Physical file not found: {file_path}")
                
                # Fallback: also try the old data/images structure for backward compatibility
                old_dataset_dir = Path("data/images") / str(dataset_id)
                old_file_path = old_dataset_dir / image.file_name
                if old_file_path.exists():
                    os.remove(old_file_path)
                    print(f"Deleted physical file from old location: {old_file_path}")
        except Exception as file_error:
            print(f"Warning: Could not delete physical file: {file_error}")
            # Continue with database deletion even if file deletion fails
        
        # Delete the image record (this will also cascade delete annotations)
        # Before deleting, clear any AnnotationFileImage references to this image
        try:
            from ..models import AnnotationFileImage
            db.query(AnnotationFileImage).filter(AnnotationFileImage.dataset_image_id == image_id).update({
                'dataset_image_id': None
            })
        except Exception:
            pass

        db.delete(image)
        
        # Update the dataset's image count
        current_image_count = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).count()
        dataset.image_count = current_image_count - 1  # -1 because we're about to delete one
        
        db.commit()
        
        return {
            "success": True,
            "message": "Image deleted successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete image: {str(e)}")
