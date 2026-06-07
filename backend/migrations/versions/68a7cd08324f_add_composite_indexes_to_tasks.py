"""add_composite_indexes_to_tasks

Revision ID: 68a7cd08324f
Revises: add_statistics_column
Create Date: 2025-12-01 20:25:04.249658

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '68a7cd08324f'
down_revision: Union[str, None] = 'add_statistics_column'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add composite indexes for improved query performance
    op.create_index(
        'idx_task_project_status_created',
        'tasks',
        ['project_id', 'status', 'created_at'],
        unique=False
    )
    op.create_index(
        'idx_task_project_type_created',
        'tasks',
        ['project_id', 'task_type', 'created_at'],
        unique=False
    )
    # Add individual index on created_at for ordering
    op.create_index(
        'ix_tasks_created_at',
        'tasks',
        ['created_at'],
        unique=False
    )


def downgrade() -> None:
    # Drop indexes in reverse order
    op.drop_index('ix_tasks_created_at', table_name='tasks')
    op.drop_index('idx_task_project_type_created', table_name='tasks')
    op.drop_index('idx_task_project_status_created', table_name='tasks')
