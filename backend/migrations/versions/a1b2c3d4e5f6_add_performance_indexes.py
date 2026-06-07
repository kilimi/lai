"""add performance indexes

Revision ID: a1b2c3d4e5f6
Revises: add_image_collection_position
Create Date: 2026-05-12

Performance improvements:
- idx_image_dataset_groupid: speeds up get_or_create_group_id (was scanning all dataset images)
- idx_image_dataset_url: speeds up _set_random_image_as_logo ORDER BY RANDOM() LIMIT 1
- idx_afi_file_cocoimgid: speeds up AnnotationFileImage lookups during COCO processing
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = 'add_image_collection_position'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Composite index for group_id lookups (get_or_create_group_id)
    op.create_index(
        'idx_image_dataset_groupid',
        'images',
        ['dataset_id', 'group_id'],
        unique=False,
        postgresql_where=sa.text('group_id IS NOT NULL'),
    )

    # Index for random logo selection (filters out NULLs cheaply)
    op.create_index(
        'idx_image_dataset_url',
        'images',
        ['dataset_id', 'url'],
        unique=False,
        postgresql_where=sa.text('url IS NOT NULL'),
    )

    # Composite index for AnnotationFileImage coco_image_id lookups
    op.create_index(
        'idx_afi_file_cocoimgid',
        'annotation_file_images',
        ['annotation_file_id', 'coco_image_id'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('idx_afi_file_cocoimgid', table_name='annotation_file_images')
    op.drop_index('idx_image_dataset_url', table_name='images')
    op.drop_index('idx_image_dataset_groupid', table_name='images')
