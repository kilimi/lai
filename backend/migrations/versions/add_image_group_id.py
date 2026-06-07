"""Add group_id to images for cross-collection correspondence

Revision ID: add_image_group_id
Revises: 5310e9164122
Create Date: 2026-03-30

"""
from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


revision: str = 'add_image_group_id'
down_revision: Union[str, None] = 'ef73370f86f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _base_name(filename: str) -> str:
    """Strip extension from filename for grouping."""
    if '.' in filename:
        return filename.rsplit('.', 1)[0].lower()
    return filename.lower()


def upgrade() -> None:
    # Add the group_id column
    op.add_column('images', sa.Column('group_id', sa.String(), nullable=True))
    op.create_index('ix_images_group_id', 'images', ['group_id'], unique=False)

    # Back-fill: group existing images by (dataset_id, base_filename)
    conn = op.get_bind()

    # Fetch all images ordered by dataset_id, file_name
    rows = conn.execute(
        text("SELECT id, dataset_id, file_name FROM images ORDER BY dataset_id, file_name")
    ).fetchall()

    # Build groups: (dataset_id, base_name) → group_uuid
    groups: dict = {}
    updates = []
    for row in rows:
        img_id, dataset_id, file_name = row
        base = _base_name(file_name or '')
        key = (dataset_id, base)
        if key not in groups:
            groups[key] = str(uuid.uuid4())
        updates.append({'img_id': img_id, 'gid': groups[key]})

    for upd in updates:
        conn.execute(
            text("UPDATE images SET group_id = :gid WHERE id = :img_id"),
            upd
        )


def downgrade() -> None:
    op.drop_index('ix_images_group_id', table_name='images')
    op.drop_column('images', 'group_id')
