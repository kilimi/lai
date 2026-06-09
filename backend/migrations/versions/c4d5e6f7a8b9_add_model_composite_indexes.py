"""Add composite indexes declared in models.py (missing on Alembic-only installs)

Revision ID: c4d5e6f7a8b9
Revises: ensure_missing_model_tables
Create Date: 2026-06-08

SQLAlchemy ``__table_args__`` indexes are applied by ``create_all()`` in dev but were never
migrated. PyPI/Docker uses Alembic only (LAI_DB_AUTO_CREATE=false).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, None] = "ensure_missing_model_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (table, index_name, columns)
_INDEXES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    # images — list/filter by dataset + collection or filename (annotation UI, uploads)
    ("images", "idx_image_dataset_filename", ("dataset_id", "file_name")),
    ("images", "idx_image_dataset_collection", ("dataset_id", "collection_id")),
    ("images", "idx_images_dataset_id_id", ("dataset_id", "id")),
    # annotations — COCO import, per-file counts, class breakdowns
    ("annotations", "idx_ann_file_image", ("annotation_file_id", "image_id")),
    ("annotations", "idx_ann_file_category", ("annotation_file_id", "category")),
    ("annotations", "idx_ann_dataset", ("dataset_id", "annotation_file_id")),
    # annotation_classes — lookup/rename class within a file
    ("annotation_classes", "idx_anncls_file_classname", ("annotation_file_id", "class_name")),
    # annotation_file_images — map COCO rows to dataset images (coco index added in a1b2c3d4e5f6)
    ("annotation_file_images", "idx_afi_file_datasetimg", ("annotation_file_id", "dataset_image_id")),
    # datasets — every project dashboard lists datasets by project_id
    ("datasets", "ix_datasets_project_id", ("project_id",)),
    # image_collections — layer list, default collection, name uniqueness per dataset
    ("image_collections", "idx_image_collections_dataset_position", ("dataset_id", "position")),
    ("image_collections", "idx_image_collections_dataset_default", ("dataset_id", "is_default")),
    ("image_collections", "idx_image_collections_dataset_name", ("dataset_id", "name")),
    # annotation_files — list by dataset ordered by created_at; processing queue
    ("annotation_files", "idx_annotation_files_dataset_created", ("dataset_id", "created_at")),
    ("annotation_files", "idx_annotation_files_dataset_status", ("dataset_id", "processing_status")),
    # tasks — watchdog scans active tasks; navbar recent list by status + time
    ("tasks", "idx_tasks_status_created", ("status", "created_at")),
)


def _has_index(table: str, name: str) -> bool:
    return any(ix.get("name") == name for ix in inspect(op.get_bind()).get_indexes(table))


def upgrade() -> None:
    for table, name, columns in _INDEXES:
        if _has_index(table, name):
            continue
        op.create_index(name, table, list(columns), unique=False)


def downgrade() -> None:
    for table, name, _columns in reversed(_INDEXES):
        if _has_index(table, name):
            op.drop_index(name, table_name=table)
