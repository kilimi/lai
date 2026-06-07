from pydantic import BaseModel, validator
from typing import List, Optional
from datetime import datetime
import json

class DatasetBase(BaseModel):
    name: str
    description: str | None = None  # Make description optional with None default
    tags: List[str] = []

    @validator('tags', pre=True)
    def validate_tags(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except:
                return []
        return v or []

class DatasetCreate(DatasetBase):
    project_id: int

class Dataset(DatasetBase):
    id: int
    created_at: datetime
    updated_at: datetime
    image_count: int = 0
    annotation_count: int = 0
    annotation_file_count: int = 0
    annotation_files: List[dict] = []
    project_id: int
    thumbnailUrl: Optional[str] = None
    logo_url: Optional[str] = None
    url: Optional[str] = None

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class DatasetResponse(Dataset):
    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class ProjectBase(BaseModel):
    name: str
    description: str | None = None  # Make description optional with None default
    is_project: bool = True
    tags: List[str] = []

    @validator('tags', pre=True)
    def validate_tags(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except:
                return []
        return v or []

class ProjectCreate(ProjectBase):
    logo: Optional[bytes] = None

class Project(ProjectBase):
    id: int
    created_at: datetime
    updated_at: datetime
    datasets: List[Dataset] = []
    logo_url: Optional[str] = None
    thumbnailUrl: Optional[str] = None  # Added for backward compatibility

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class Image(BaseModel):
    id: int
    datasetId: int
    fileName: str
    fileSize: int
    width: int
    height: int
    url: str
    thumbnailUrl: str
    uploadedAt: datetime
    annotationsCount: int = 0
    groupId: Optional[str] = None

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class ImageCollectionBase(BaseModel):
    name: str
    description: Optional[str] = None
    is_default: bool = False

class ImageCollectionCreate(ImageCollectionBase):
    dataset_id: int

class ImageCollection(ImageCollectionBase):
    id: int
    dataset_id: int
    position: int = 0
    created_at: datetime
    updated_at: datetime
    image_count: int = 0

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class ImageCollectionWithImages(ImageCollection):
    images: List[Image] = []

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class TaskBase(BaseModel):
    name: str
    description: Optional[str] = None
    task_type: str
    project_id: Optional[int] = None  # None when dataset has no project (e.g. legacy)
    task_metadata: Optional[dict] = None

class TaskCreate(TaskBase):
    pass

class Task(TaskBase):
    id: int
    status: str = 'pending'
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error_message: Optional[str] = None
    progress: float = 0.0

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class AugmentationBase(BaseModel):
    source_dataset_ids: List[int]
    augmentation_methods: List[str]
    method_parameters: dict = {}
    augmentation_factor: str = '2'
    transform_annotations: bool = True
    annotation_settings: dict = {}

class AugmentationCreate(AugmentationBase):
    task_id: int
    target_dataset_id: int

class AnnotationFileBase(BaseModel):
    name: str
    format: str = 'COCO'
    type: Optional[str] = None
    tags: List[str] = []

    @validator('tags', pre=True)
    def validate_tags(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except:
                return []
        return v or []

class AnnotationFileCreate(AnnotationFileBase):
    id: str
    dataset_id: int
    file_size: Optional[int] = None
    annotation_count: int = 0
    image_count: int = 0
    category_count: int = 0

class AnnotationFile(AnnotationFileBase):
    id: str
    dataset_id: int
    file_size: Optional[int] = None
    annotation_count: int = 0
    image_count: int = 0
    category_count: int = 0
    is_processed: bool = False
    processing_status: str = 'pending'
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class Augmentation(AugmentationBase):
    id: int
    task_id: int
    target_dataset_id: int
    created_at: datetime

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class CreateAugmentedDatasetRequest(BaseModel):
    name: str
    description: Optional[str] = None
    project_id: int
    source_datasets: List[int]
    augmentation_methods: List[str]
    method_parameters: dict = {}
    augmentation_factor: str = '2'

# Annotation response schemas
class AnnotationFileResponse(AnnotationFile):
    """Response schema for AnnotationFile"""
    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class AnnotationResponse(BaseModel):
    """Response schema for Annotation"""
    id: int
    annotation_file_id: Optional[str] = None
    image_id: int
    dataset_id: int
    coco_image_id: Optional[int] = None
    coco_annotation_id: Optional[int] = None
    category_id: Optional[int] = None
    category: str
    bbox_x: Optional[float] = None
    bbox_y: Optional[float] = None
    bbox_width: Optional[float] = None
    bbox_height: Optional[float] = None
    bbox: Optional[List[float]] = None
    segmentation: Optional[dict] = None
    area: Optional[float] = None
    confidence: float = 1.0
    uploaded_at: datetime

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }

class AnnotationClassResponse(BaseModel):
    """Response schema for AnnotationClass"""
    id: int
    annotation_file_id: str
    class_name: str
    category_id: Optional[int] = None
    count: int = 0
    color: str = '#ea384c'
    opacity: float = 0.25
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }