from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from typing import List, Optional
import os
import shutil
from datetime import datetime
import uuid
from pathlib import Path
from PIL import Image as PILImage
import io
import cv2
import numpy as np

from ..database import get_db
from ..http_utils import public_request_base_url
from app.services.dataset_collections_service import ensure_default_image_collection
from ..models import ImageCollection, Image, Dataset
from ..schemas import (
    ImageCollectionCreate, 
    ImageCollection as ImageCollectionSchema,
    ImageCollectionWithImages,
    Image as ImageSchema
)

router = APIRouter()


def _delete_image_physical_files(project_id: int, dataset_id: int, file_name: str) -> None:
    """
    Remove the main image file, optional thumbnails/ copy, and generated .thumbs cache files.
    Tolerates missing paths (partial cleanup).
    """
    image_dirs = [
        Path("projects") / str(project_id) / str(dataset_id) / "images",
        Path("data") / "images" / str(dataset_id),
    ]
    stem = Path(file_name).stem
    for img_dir in image_dirs:
        main_path = img_dir / file_name
        if main_path.is_file():
            try:
                main_path.unlink()
            except OSError:
                pass
        thumb_copy = img_dir / "thumbnails" / file_name
        if thumb_copy.is_file():
            try:
                thumb_copy.unlink()
            except OSError:
                pass
        dot_thumbs = img_dir / ".thumbs"
        if dot_thumbs.is_dir():
            for suffix in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                try:
                    for p in dot_thumbs.glob(f"{stem}_*{suffix}"):
                        if p.is_file():
                            p.unlink(missing_ok=True)
                except OSError:
                    pass

class ReorderCollectionsRequest(BaseModel):
    ordered_collection_ids: List[int]


def _base_name(filename: str) -> str:
    """Return filename without extension, lower-cased, for group matching."""
    if filename and '.' in filename:
        return filename.rsplit('.', 1)[0].lower()
    return (filename or '').lower()


def get_or_create_group_id(db: Session, dataset_id: int, file_name: str) -> str:
    """
    Return the group_id shared by all images in this dataset with the same base filename.
    Creates a new UUID if no group exists yet.
    Uses SQL filtering instead of loading all dataset images.
    """
    base = _base_name(file_name)
    # Query only images that could match: file_name starts with base (with or without extension)
    existing_group_id = (
        db.query(Image.group_id)
        .filter(
            Image.dataset_id == dataset_id,
            Image.group_id.isnot(None),
            func.lower(
                func.regexp_replace(Image.file_name, r'\.[^.]*$', '')
            ) == base,
        )
        .limit(1)
        .scalar()
    )
    if existing_group_id:
        return existing_group_id
    return str(uuid.uuid4())

@router.get("/datasets/{dataset_id}/image-collections", response_model=List[ImageCollectionWithImages])
def get_image_collections(request: Request, dataset_id: int, db: Session = Depends(get_db)):
    """Get all image collections for a dataset"""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    base_url = public_request_base_url(request)

    collections = db.query(ImageCollection).filter(
        ImageCollection.dataset_id == dataset_id
    ).order_by(ImageCollection.position.asc(), ImageCollection.created_at.asc()).all()

    if not collections:
        ensure_default_image_collection(db, dataset_id)
        db.commit()
        collections = db.query(ImageCollection).filter(
            ImageCollection.dataset_id == dataset_id
        ).order_by(ImageCollection.position.asc(), ImageCollection.created_at.asc()).all()

    # Default collection — attach orphan images with collection_id NULL.
    default_collection = next((c for c in collections if c.is_default), None)
    if default_collection is None and collections:
        default_collection = collections[0]

    if default_collection:
        updated_count = (
            db.query(Image)
            .filter(Image.dataset_id == dataset_id, Image.collection_id.is_(None))
            .update({"collection_id": default_collection.id}, synchronize_session=False)
        )
        if updated_count:
            db.commit()

    default_collection_id = default_collection.id if default_collection else None

    def image_to_dict(img):
        return {
            "id": img.id,
            "datasetId": img.dataset_id,
            "fileName": img.file_name,
            "fileSize": img.file_size,
            "width": img.width,
            "height": img.height,
            "url": f"{base_url}{img.url}" if img.url and img.url.startswith('/') else img.url,
            "thumbnailUrl": f"{base_url}{img.thumbnail_url}?thumb=300" if img.thumbnail_url and img.thumbnail_url.startswith('/') else img.thumbnail_url,
            "uploadedAt": img.uploaded_at,
            "annotationsCount": img.annotations_count,
            "groupId": img.group_id,
        }

    result = []
    for collection in collections:
        if collection.is_default and default_collection_id is not None:
            # Default collection: return all images in dataset that are in this collection OR unassigned
            default_images = db.query(Image).filter(
                Image.dataset_id == dataset_id,
                or_(Image.collection_id == default_collection_id, Image.collection_id.is_(None))
            ).order_by(Image.id.asc()).all()
            images_list = [image_to_dict(img) for img in default_images]
        else:
            images_list = [image_to_dict(img) for img in collection.images]
        collection_dict = {
            "id": collection.id,
            "dataset_id": collection.dataset_id,
            "name": collection.name,
            "description": collection.description,
            "is_default": collection.is_default,
            "position": collection.position,
            "created_at": collection.created_at,
            "updated_at": collection.updated_at,
            "image_count": len(images_list),
            "images": images_list
        }
        result.append(collection_dict)
    
    return result

@router.post("/datasets/{dataset_id}/image-collections", response_model=ImageCollectionSchema)
def create_image_collection(
    dataset_id: int, 
    collection_data: ImageCollectionCreate, 
    db: Session = Depends(get_db)
):
    """Create a new image collection for a dataset"""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    # Check if collection name already exists in this dataset
    existing = db.query(ImageCollection).filter(
        ImageCollection.dataset_id == dataset_id,
        ImageCollection.name == collection_data.name
    ).first()
    
    if existing:
        raise HTTPException(status_code=400, detail="Collection name already exists")
    
    collection = ImageCollection(
        dataset_id=dataset_id,
        name=collection_data.name,
        description=collection_data.description,
        is_default=collection_data.is_default,
        position=(db.query(func.coalesce(func.max(ImageCollection.position), -1))
                    .filter(ImageCollection.dataset_id == dataset_id)
                    .scalar() or -1) + 1,
    )
    
    db.add(collection)
    db.commit()
    db.refresh(collection)
    
    return collection

@router.delete("/datasets/{dataset_id}/image-collections/{collection_id}")
def delete_image_collection(
    dataset_id: int,
    collection_id: int,
    db: Session = Depends(get_db)
):
    """Delete an image collection and all images in it (database records and physical files)."""
    collection = db.query(ImageCollection).filter(
        ImageCollection.id == collection_id,
        ImageCollection.dataset_id == dataset_id
    ).first()

    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")

    if collection.is_default:
        # Promote another collection to default before deleting this one
        other = db.query(ImageCollection).filter(
            ImageCollection.dataset_id == dataset_id,
            ImageCollection.id != collection_id,
        ).order_by(ImageCollection.position.asc(), ImageCollection.created_at.asc()).first()
        if other:
            other.is_default = True
        # If there is no other collection, we still allow deletion (dataset will have no collections)

    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    project_id = dataset.project_id or 0

    AnnotationFileImage = None
    try:
        from ..models import AnnotationFileImage
    except ImportError:
        pass

    images_in_collection = db.query(Image).filter(Image.collection_id == collection_id).all()
    for image in images_in_collection:
        try:
            _delete_image_physical_files(project_id, dataset_id, image.file_name)
        except Exception:
            pass
        if AnnotationFileImage is not None:
            try:
                db.query(AnnotationFileImage).filter(
                    AnnotationFileImage.dataset_image_id == image.id
                ).update({"dataset_image_id": None})
            except Exception:
                pass
        db.delete(image)

    db.delete(collection)
    current_count = db.query(Image).filter(Image.dataset_id == dataset_id).count()
    dataset.image_count = current_count
    db.commit()

    return {"message": "Collection and all its images deleted successfully"}


@router.put("/datasets/{dataset_id}/image-collections/reorder")
def reorder_image_collections(
    dataset_id: int,
    payload: ReorderCollectionsRequest,
    db: Session = Depends(get_db)
):
    """Persist left-to-right order of image collections for a dataset."""
    ids = payload.ordered_collection_ids or []
    if not ids:
        raise HTTPException(status_code=400, detail="ordered_collection_ids is required")

    collections = db.query(ImageCollection).filter(ImageCollection.dataset_id == dataset_id).all()
    if not collections:
        raise HTTPException(status_code=404, detail="No collections found for dataset")

    existing_ids = {c.id for c in collections}
    requested_ids = set(ids)
    if requested_ids != existing_ids:
        raise HTTPException(status_code=400, detail="ordered_collection_ids must include all dataset collections exactly once")

    seen = set()
    for cid in ids:
        if cid in seen:
            raise HTTPException(status_code=400, detail="ordered_collection_ids contains duplicates")
        seen.add(cid)

    by_id = {c.id: c for c in collections}
    for idx, cid in enumerate(ids):
        by_id[cid].position = idx

    db.commit()
    return {"message": "Collections reordered successfully"}

@router.post("/datasets/{dataset_id}/image-collections/{collection_id}/images")
async def upload_images_to_collection(
    request: Request,
    dataset_id: int,
    collection_id: int,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db)
):
    """Upload images directly to a specific collection"""
    collection = db.query(ImageCollection).filter(
        ImageCollection.id == collection_id,
        ImageCollection.dataset_id == dataset_id
    ).first()
    
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")
    
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    base_url = public_request_base_url(request)
    
    # Create upload directory using the same structure as the main upload
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
        
        # Check if file already exists on disk (across all collections)
        original_path = dataset_dir / clean_filename
        final_filename = clean_filename
        counter = 1
        
        # Generate unique filename if file already exists on disk
        # Include collection name for better identification
        while original_path.exists():
            name, ext = os.path.splitext(clean_filename)
            if counter == 1:
                # First conflict: use collection name
                final_filename = f"{name}_{collection.name.replace(' ', '_')}{ext}"
            else:
                # Subsequent conflicts: use collection name + number
                final_filename = f"{name}_{collection.name.replace(' ', '_')}_{counter}{ext}"
            original_path = dataset_dir / final_filename
            counter += 1
        
        file_path = original_path
        
        try:
            contents = await file.read()
            
            # Extract image dimensions using Pillow with OpenCV fallback
            width, height = 0, 0
            is_tiff_file = final_filename.lower().endswith(('.tif', '.tiff'))

            try:
                img = PILImage.open(io.BytesIO(contents))
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
                            img = PILImage.merge('RGB', (bands[0], bands[1], bands[2]))
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
                            
                            print(f"DEBUG: Converted image shape: {cv_img.shape}, dtype: {cv_img.dtype}")
                            
                            # Convert to PNG using PIL for better quality control
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
                            
                            # Use PIL to save PNG for better control
                            pil_img = PILImage.fromarray(cv_img, 'RGB')
                            pil_img.save(str(file_path), 'PNG')
                            
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
            image = Image(
                dataset_id=dataset_id,
                collection_id=collection_id,  # Assign to specific collection
                file_name=final_filename,  # Use the unique filename
                file_size=len(contents),
                width=width,
                height=height,
                url=relative_url,
                thumbnail_url=relative_url,
                uploaded_at=datetime.utcnow(),
                group_id=get_or_create_group_id(db, dataset_id, final_filename),
            )
            
            db.add(image)
            uploaded_images.append(image)
            print(f"Adding new image to collection {collection_id}: {final_filename} ({width}x{height})")
                
        except Exception as e:
            print(f"Error uploading file {file.filename}: {e}")
            continue
    
    # Update dataset image count
    current_image_count = db.query(Image).filter(Image.dataset_id == dataset_id).count()
    dataset.image_count = current_image_count + len([img for img in uploaded_images if img.id is None])  # Only count new images
    
    db.commit()
    
    # Set random image as logo if no logo is set
    if not dataset.thumbnailUrl and not dataset.logo_url and not dataset.logo:
        images = db.query(Image).filter(Image.dataset_id == dataset_id).all()
        if images:
            import random
            random_image = random.choice(images)
            if random_image.url:
                if random_image.url.startswith('/'):
                    dataset.thumbnailUrl = f"{base_url}{random_image.url}?thumb=300" if base_url else random_image.url
                    dataset.logo_url = f"{base_url}{random_image.url}?thumb=300" if base_url else random_image.url
                else:
                    dataset.thumbnailUrl = random_image.url
                    dataset.logo_url = random_image.url
                db.commit()
                print(f"Set random image {random_image.file_name} as logo for dataset {dataset_id}")
    
    return {
        "message": f"Successfully uploaded {len(files)} images to collection '{collection.name}'",
        "images": [
            {
                "id": str(img.id),
                "datasetId": str(dataset_id),
                "fileName": img.file_name,
                "fileSize": img.file_size,
                "width": img.width,
                "height": img.height,
                "url": f"{base_url}{img.url}" if img.url.startswith('/') else img.url,
                "thumbnailUrl": f"{base_url}{img.thumbnail_url}?thumb=300" if img.thumbnail_url.startswith('/') else img.thumbnail_url,
                "uploadedAt": img.uploaded_at.isoformat(),
                "annotationsCount": img.annotations_count,
                "groupId": img.group_id,
            }
            for img in uploaded_images
        ]
    }

@router.put("/images/{image_id}/collection")
def move_image_to_collection(
    image_id: int,
    request: dict,  # {"collection_id": int}
    db: Session = Depends(get_db)
):
    """Move an image to a different collection"""
    collection_id = request.get("collection_id")
    if not collection_id:
        raise HTTPException(status_code=400, detail="collection_id is required")
    
    image = db.query(Image).filter(Image.id == image_id).first()
    if not image:
        raise HTTPException(status_code=404, detail="Image not found")
    
    collection = db.query(ImageCollection).filter(
        ImageCollection.id == collection_id,
        ImageCollection.dataset_id == image.dataset_id
    ).first()
    
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")
    
    image.collection_id = collection_id
    db.commit()
    
    return {"message": "Image moved successfully"}

@router.post("/datasets/{dataset_id}/image-collections/initialize")
def initialize_default_collection(dataset_id: int, db: Session = Depends(get_db)):
    """Initialize default collection for existing datasets"""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    # Check if default collection already exists
    default_collection = db.query(ImageCollection).filter(
        ImageCollection.dataset_id == dataset_id,
        ImageCollection.is_default == True
    ).first()
    
    if default_collection:
        return {"message": "Default collection already exists"}
    
    # Create default collection
    default_collection = ImageCollection(
        dataset_id=dataset_id,
        name="RGB Images",
        description="Default image collection",
        is_default=True,
        position=0,
    )
    db.add(default_collection)
    db.commit()
    db.refresh(default_collection)
    
    # Move all existing images to default collection
    images = db.query(Image).filter(
        Image.dataset_id == dataset_id,
        Image.collection_id.is_(None)
    ).all()
    
    for image in images:
        image.collection_id = default_collection.id
    
    db.commit()
    
    return {
        "message": "Default collection initialized",
        "collection": default_collection,
        "images_moved": len(images)
    }


@router.post("/datasets/{dataset_id}/image-collections/sync-groups")
def sync_image_groups(dataset_id: int, db: Session = Depends(get_db)):
    """
    Back-fill group_id for all images in a dataset.
    Images with the same base filename (ignoring extension) across collections
    will share the same group_id.
    """
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    images = db.query(Image).filter(Image.dataset_id == dataset_id).all()

    # Build (base_name → group_id) map from already-assigned images first
    groups: dict[str, str] = {}
    for img in images:
        if img.group_id:
            base = _base_name(img.file_name)
            if base not in groups:
                groups[base] = img.group_id

    # Assign / fix group_ids
    updated = 0
    for img in images:
        base = _base_name(img.file_name)
        if base not in groups:
            groups[base] = str(uuid.uuid4())
        if img.group_id != groups[base]:
            img.group_id = groups[base]
            updated += 1

    db.commit()

    return {
        "message": f"Group IDs synced for dataset {dataset_id}",
        "total_images": len(images),
        "updated": updated,
        "groups": len(groups),
    }
