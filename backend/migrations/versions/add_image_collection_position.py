"""Add position to image_collections

Revision ID: add_image_collection_position
Revises: add_image_group_id
Create Date: 2026-04-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_image_collection_position'
down_revision: Union[str, None] = 'add_image_group_id'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('image_collections', sa.Column('position', sa.Integer(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT id, dataset_id, is_default, created_at FROM image_collections "
        "ORDER BY dataset_id ASC, is_default DESC, created_at ASC, id ASC"
    )).fetchall()

    current_dataset_id = None
    pos = 0
    for row in rows:
        if row.dataset_id != current_dataset_id:
            current_dataset_id = row.dataset_id
            pos = 0
        bind.execute(
            sa.text("UPDATE image_collections SET position = :position WHERE id = :id"),
            {"position": pos, "id": row.id},
        )
        pos += 1

    op.alter_column('image_collections', 'position', nullable=False, server_default='0')


def downgrade() -> None:
    op.drop_column('image_collections', 'position')

