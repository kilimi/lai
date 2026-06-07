from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean, LargeBinary, JSON, Float, Index
from sqlalchemy.orm import relationship
from datetime import datetime
import json
from .database import Base

class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text, nullable=True)  # Make description nullable
    _tags = Column('tags', JSON, default=list)  # Add tags support
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_project = Column(Boolean, default=True)
    logo = Column(LargeBinary, nullable=True)
    logo_url = Column(String, nullable=True)

    datasets = relationship("Dataset", back_populates="project")

    @property
    def tags(self):
        """Get the tags as a list"""
        if isinstance(self._tags, str):
            try:
                return json.loads(self._tags)
            except json.JSONDecodeError:
                return []
        return self._tags or []

    @tags.setter
    def tags(self, value):
        """Set the tags, ensuring they're stored as JSON"""
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = []
        self._tags = value

class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text, nullable=True)  # Make description nullable
    _tags = Column('tags', JSON, default=list)  # Renamed to _tags
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    image_count = Column(Integer, default=0)
    # annotation_count is computed on demand from related annotations; remove persistent column
    project_id = Column(Integer, ForeignKey("projects.id"))
    logo = Column(LargeBinary, nullable=True)
    logo_url = Column(String, nullable=True)
    thumbnailUrl = Column(String, nullable=True)
    url = Column(String, nullable=True)

    project = relationship("Project", back_populates="datasets")
    # Add relationships with cascade delete
    images = relationship("Image", cascade="all, delete-orphan", back_populates="dataset")
    annotations = relationship("Annotation", cascade="all, delete-orphan", back_populates="dataset")
    annotation_files = relationship("AnnotationFile", cascade="all, delete-orphan", back_populates="dataset")
    image_collections = relationship("ImageCollection", cascade="all, delete-orphan", back_populates="dataset")

    @property
    def tags(self):
        """Get the tags as a list"""
        if isinstance(self._tags, str):
            try:
                return json.loads(self._tags)
            except json.JSONDecodeError:
                return []
        return self._tags or []

    @tags.setter
    def tags(self, value):
        """Set the tags, ensuring they're stored as JSON"""
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = []
        self._tags = value

    @property
    def actual_annotation_count(self):
        """Get the actual annotation count, calculating it if the stored count is 0"""
        # Compute directly from related annotations when possible
        if hasattr(self, 'annotations') and self.annotations is not None:
            return len(self.annotations)
        return 0

    @property
    def actual_annotation_file_count(self):
        """Compute annotation file count from related annotation_files table."""
        # If relationship is loaded, return its length
        if hasattr(self, 'annotation_files') and self.annotation_files is not None:
            return len(self.annotation_files)
        # Fallback to 0 when relationship isn't available
        return 0

    @property
    def annotation_file_count(self):
        """Compatibility alias so code can read dataset.annotation_file_count as a computed value."""
        return self.actual_annotation_file_count


class Image(Base):
    __tablename__ = "images"
    __table_args__ = (
        Index('idx_image_dataset_filename', 'dataset_id', 'file_name'),
        Index('idx_image_dataset_collection', 'dataset_id', 'collection_id'),
        # Supports get_or_create_group_id: find images by dataset + group_id
        Index('idx_image_dataset_groupid', 'dataset_id', 'group_id'),
        # Supports _set_random_image_as_logo: filtered scan on dataset + url
        Index('idx_image_dataset_url', 'dataset_id', 'url'),
    )

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), index=True)
    file_name = Column(String, index=True)
    file_size = Column(Integer)
    width = Column(Integer)
    height = Column(Integer)
    url = Column(String)
    thumbnail_url = Column(String)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    annotations_count = Column(Integer, default=0)
    collection_id = Column(Integer, ForeignKey("image_collections.id"), nullable=True, index=True)
    group_id = Column(String, nullable=True, index=True)

    dataset = relationship("Dataset", back_populates="images")
    annotations = relationship("Annotation", cascade="all, delete-orphan", back_populates="image")
    collection = relationship("ImageCollection", back_populates="images")


class ImageCollection(Base):
    __tablename__ = "image_collections"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), index=True)
    name = Column(String, index=True)
    description = Column(Text, nullable=True)
    is_default = Column(Boolean, default=False)  # True for the main "RGB Images" collection
    position = Column(Integer, nullable=False, default=0)  # Left-to-right order in UI
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="image_collections")
    images = relationship("Image", back_populates="collection")

    @property
    def image_count(self):
        """Get the number of images in this collection"""
        return len(self.images) if self.images else 0


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (
        Index('idx_ann_file_image', 'annotation_file_id', 'image_id'),
        Index('idx_ann_file_category', 'annotation_file_id', 'category'),
        Index('idx_ann_dataset', 'dataset_id', 'annotation_file_id'),
    )

    id = Column(Integer, primary_key=True, index=True)
    annotation_file_id = Column(String, ForeignKey("annotation_files.id"), nullable=True, index=True)
    image_id = Column(Integer, ForeignKey("images.id"), index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), index=True)
    coco_image_id = Column(Integer, nullable=True, index=True)
    coco_annotation_id = Column(Integer, nullable=True, index=True)
    category_id = Column(Integer, nullable=True, index=True)
    category = Column(String, index=True)
    bbox_x = Column(Float, nullable=True)  # Normalized bbox coordinates
    bbox_y = Column(Float, nullable=True)
    bbox_width = Column(Float, nullable=True) 
    bbox_height = Column(Float, nullable=True)
    bbox = Column(JSON, nullable=True)  # [x, y, width, height] - keep for backward compatibility
    segmentation = Column(JSON, nullable=True)  # COCO format segmentation
    area = Column(Float, nullable=True)
    confidence = Column(Float, default=1.0)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="annotations")
    image = relationship("Image", back_populates="annotations")
    annotation_file = relationship("AnnotationFile", back_populates="annotations")


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        # Composite index for common query pattern: filtering by project_id, status, and ordering by created_at
        Index('idx_task_project_status_created', 'project_id', 'status', 'created_at'),
        # Composite index for task type queries
        Index('idx_task_project_type_created', 'project_id', 'task_type', 'created_at'),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text, nullable=True)
    task_type = Column(String, index=True)  # 'augmentation', 'training', 'inference', etc.
    status = Column(String, default='pending', index=True)  # 'pending', 'running', 'completed', 'failed'
    project_id = Column(Integer, ForeignKey("projects.id"), index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)  # Add index for ordering
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)
    progress = Column(Float, default=0.0)  # Progress percentage (0-100)
    task_metadata = Column(JSON, nullable=True)  # Additional task-specific data

    project = relationship("Project")
    augmentation = relationship("Augmentation", back_populates="task", uselist=False)


class WorkerGpuStatus(Base):
    __tablename__ = "worker_gpu_status"

    id = Column(Integer, primary_key=True, default=1)
    has_gpu = Column(Boolean, default=False, nullable=False)
    gpu_count = Column(Integer, default=0, nullable=False)
    gpus = Column(JSON, nullable=False, default=list)
    memory_used_mb = Column(Integer, default=0, nullable=False)
    memory_total_mb = Column(Integer, default=0, nullable=False)
    source = Column(String, default='celery_worker', nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class AnnotationFile(Base):
    __tablename__ = "annotation_files"

    id = Column(String, primary_key=True, index=True)  # Use string ID to match frontend
    dataset_id = Column(Integer, ForeignKey("datasets.id"), index=True)
    name = Column(String, index=True)
    format = Column(String, default='COCO', index=True)  # COCO, YOLO, etc.
    type = Column(String, nullable=True, index=True)  # classification, segmentation, depthation, depth
    _tags = Column('tags', JSON, default=list)  # Store tags as JSON
    file_size = Column(Integer, nullable=True)
    annotation_count = Column(Integer, default=0)
    image_count = Column(Integer, default=0)
    category_count = Column(Integer, default=0)
    statistics = Column(JSON, nullable=True)  # Per-class annotation counts and average areas
    is_processed = Column(Boolean, default=False, index=True)  # Whether file has been processed into DB
    processing_status = Column(String, default='pending', index=True)  # pending, processing, completed, failed
    error_message = Column(Text, nullable=True)  # Error message if processing failed
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    dataset = relationship("Dataset", back_populates="annotation_files")
    annotations = relationship("Annotation", back_populates="annotation_file", cascade="all, delete-orphan")
    annotation_classes = relationship("AnnotationClass", back_populates="annotation_file", cascade="all, delete-orphan")
    # Keep per-file list of images that were present in the original file (COCO images list)
    annotation_images = relationship("AnnotationFileImage", back_populates="annotation_file", cascade="all, delete-orphan")

    @property
    def tags(self):
        """Get the tags as a list"""
        if isinstance(self._tags, str):
            try:
                return json.loads(self._tags)
            except json.JSONDecodeError:
                return []
        return self._tags or []

    @tags.setter
    def tags(self, value):
        """Set the tags, ensuring they're stored as JSON"""
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = []
        self._tags = value


class AnnotationClass(Base):
    __tablename__ = "annotation_classes"
    __table_args__ = (
        Index('idx_anncls_file_classname', 'annotation_file_id', 'class_name'),
    )

    id = Column(Integer, primary_key=True, index=True)
    annotation_file_id = Column(String, ForeignKey("annotation_files.id"), index=True)
    class_name = Column(String, index=True)
    category_id = Column(Integer, nullable=True)
    count = Column(Integer, default=0)
    color = Column(String, default='#ea384c')  # Hex color
    opacity = Column(Float, default=0.25)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    annotation_file = relationship("AnnotationFile", back_populates="annotation_classes")


class AnnotationFileImage(Base):
    __tablename__ = "annotation_file_images"
    __table_args__ = (
        Index('idx_afi_file_datasetimg', 'annotation_file_id', 'dataset_image_id'),
        # Supports COCO image-id lookup during annotation processing
        Index('idx_afi_file_cocoimgid', 'annotation_file_id', 'coco_image_id'),
    )

    id = Column(Integer, primary_key=True, index=True)
    annotation_file_id = Column(String, ForeignKey("annotation_files.id"), index=True)
    coco_image_id = Column(Integer, nullable=True, index=True)
    file_name = Column(String, nullable=True)
    dataset_image_id = Column(Integer, ForeignKey("images.id"), nullable=True, index=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    annotation_file = relationship("AnnotationFile", back_populates="annotation_images")


class Augmentation(Base):
    __tablename__ = "augmentations"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), unique=True, index=True)
    source_dataset_ids = Column(JSON)  # List of source dataset IDs
    target_dataset_id = Column(Integer, ForeignKey("datasets.id"), index=True)
    augmentation_methods = Column(JSON)  # List of augmentation method names
    method_parameters = Column(JSON)  # Parameters for each augmentation method
    augmentation_factor = Column(String, default='2')  # How many augmented images per original
    transform_annotations = Column(Boolean, default=True)  # Whether to transform annotations
    annotation_settings = Column(JSON)  # Settings for annotation transformation
    created_at = Column(DateTime, default=datetime.utcnow)

    task = relationship("Task", back_populates="augmentation")
    target_dataset = relationship("Dataset")


class DatasetGroup(Base):
    __tablename__ = "dataset_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    description = Column(Text, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), index=True)
    dataset_ids = Column(JSON, default=list)  # List of dataset IDs in this group
    url = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship("Project")

    @property
    def dataset_count(self):
        """Get the number of datasets in this group"""
        if isinstance(self.dataset_ids, str):
            try:
                ids = json.loads(self.dataset_ids)
                return len(ids) if ids else 0
            except json.JSONDecodeError:
                return 0
        return len(self.dataset_ids) if self.dataset_ids else 0

    @property
    def datasets_list(self):
        """Get the dataset IDs as a list"""
        if isinstance(self.dataset_ids, str):
            try:
                return json.loads(self.dataset_ids)
            except json.JSONDecodeError:
                return []
        return self.dataset_ids or []

    @datasets_list.setter
    def datasets_list(self, value):
        """Set the dataset IDs, ensuring they're stored as JSON"""
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = []
        self.dataset_ids = value


class BackupSettings(Base):
    __tablename__ = "backup_settings"

    id = Column(Integer, primary_key=True, index=True)
    enabled = Column(Boolean, default=False)
    backup_path = Column(String, nullable=True)  # Path where backups are stored
    frequency_hours = Column(Integer, default=24)  # How often to backup (in hours)
    retention_days = Column(Integer, default=30)  # How many days to keep backups
    last_backup_at = Column(DateTime, nullable=True)
    next_backup_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class BackupRecord(Base):
    __tablename__ = "backup_records"

    id = Column(Integer, primary_key=True, index=True)
    backup_path = Column(String, index=True)  # Full path to backup directory
    backup_type = Column(String, default='full')  # 'full' or 'incremental'
    parent_backup_id = Column(Integer, ForeignKey("backup_records.id"), nullable=True)  # For incremental backups
    file_count = Column(Integer, default=0)
    total_size_bytes = Column(Integer, default=0)
    database_backed_up = Column(Boolean, default=True)
    files_backed_up = Column(Boolean, default=True)
    status = Column(String, default='completed')  # 'completed', 'failed', 'in_progress'
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    backup_metadata = Column('metadata', JSON, nullable=True)  # Additional backup metadata (column name is 'metadata' but attribute is 'backup_metadata')

    parent_backup = relationship("BackupRecord", remote_side=[id])


class Pipeline(Base):
    __tablename__ = "pipelines"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), index=True)
    name = Column(String, index=True)
    nodes = Column(JSON)  # ReactFlow nodes
    edges = Column(JSON)  # ReactFlow edges
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship("Project")