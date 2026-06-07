"""add backup tables

Revision ID: add_backup_tables
Revises: 
Create Date: 2024-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_backup_tables'
down_revision = '68a7cd08324f'  # Add composite indexes to tasks
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create backup_settings table
    op.create_table(
        'backup_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('backup_path', sa.String(), nullable=True),
        sa.Column('frequency_hours', sa.Integer(), nullable=True, server_default='24'),
        sa.Column('retention_days', sa.Integer(), nullable=True, server_default='30'),
        sa.Column('last_backup_at', sa.DateTime(), nullable=True),
        sa.Column('next_backup_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_backup_settings_id'), 'backup_settings', ['id'], unique=False)

    # Create backup_records table
    op.create_table(
        'backup_records',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('backup_path', sa.String(), nullable=True),
        sa.Column('backup_type', sa.String(), nullable=True, server_default='full'),
        sa.Column('parent_backup_id', sa.Integer(), nullable=True),
        sa.Column('file_count', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('total_size_bytes', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('database_backed_up', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('files_backed_up', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('status', sa.String(), nullable=True, server_default='completed'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('metadata', postgresql.JSON(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(['parent_backup_id'], ['backup_records.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_backup_records_id'), 'backup_records', ['id'], unique=False)
    op.create_index(op.f('ix_backup_records_backup_path'), 'backup_records', ['backup_path'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_backup_records_backup_path'), table_name='backup_records')
    op.drop_index(op.f('ix_backup_records_id'), table_name='backup_records')
    op.drop_table('backup_records')
    op.drop_index(op.f('ix_backup_settings_id'), table_name='backup_settings')
    op.drop_table('backup_settings')
