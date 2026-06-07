"""Drop annotation_count from datasets

Revision ID: drop_dataset_annotation_count
Revises: 5310e9164122
Create Date: 2025-09-03 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'drop_dataset_annotation_count'
down_revision = '5310e9164122'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if 'datasets' in inspector.get_table_names():
        columns = [col['name'] for col in inspector.get_columns('datasets')]
        if 'annotation_count' in columns:
            try:
                op.drop_column('datasets', 'annotation_count')
            except Exception:
                # Some DBs require more careful handling; ignore errors to allow upgrade to proceed
                pass


def downgrade() -> None:
    # Recreate the column in downgrade
    op.add_column('datasets', sa.Column('annotation_count', sa.Integer(), nullable=True))
    try:
        op.execute("UPDATE datasets SET annotation_count = 0 WHERE annotation_count IS NULL")
    except Exception:
        pass
