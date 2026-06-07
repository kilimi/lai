"""add statistics column to annotation_files

Revision ID: add_statistics_column
Revises: dc723c15f33d
Create Date: 2025-11-26

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON

# revision identifiers, used by Alembic.
revision = 'add_statistics_column'
down_revision = 'dc723c15f33d'
branch_labels = None
depends_on = None


def upgrade():
    # Add statistics column to annotation_files table
    op.add_column('annotation_files', sa.Column('statistics', JSON, nullable=True))


def downgrade():
    # Remove statistics column
    op.drop_column('annotation_files', 'statistics')
