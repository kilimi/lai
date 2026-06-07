"""Add missing annotation database columns

Revision ID: add_missing_annotation_columns
Revises: 2f7007f263a6
Create Date: 2025-08-13 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'add_missing_annotation_columns'
down_revision = '2f7007f263a6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Check if annotation_classes table exists, if not create it
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    
    if 'annotation_classes' not in inspector.get_table_names():
        op.create_table('annotation_classes',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('annotation_file_id', sa.String(), nullable=True),
            sa.Column('class_name', sa.String(), nullable=True),
            sa.Column('category_id', sa.Integer(), nullable=True),
            sa.Column('count', sa.Integer(), nullable=True),
            sa.Column('color', sa.String(), nullable=True),
            sa.Column('opacity', sa.Float(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['annotation_file_id'], ['annotation_files.id'], ),
            sa.PrimaryKeyConstraint('id')
        )
        op.create_index(op.f('ix_annotation_classes_class_name'), 'annotation_classes', ['class_name'], unique=False)
        op.create_index(op.f('ix_annotation_classes_id'), 'annotation_classes', ['id'], unique=False)
    
    # Add new columns to annotation_files table if they don't exist
    annotation_files_columns = [col['name'] for col in inspector.get_columns('annotation_files')]
    
    if 'is_processed' not in annotation_files_columns:
        op.add_column('annotation_files', sa.Column('is_processed', sa.Boolean(), nullable=True))
    if 'processing_status' not in annotation_files_columns:
        op.add_column('annotation_files', sa.Column('processing_status', sa.String(), nullable=True))
    if 'error_message' not in annotation_files_columns:
        op.add_column('annotation_files', sa.Column('error_message', sa.Text(), nullable=True))
    
    # Make file_path nullable (for DB-only storage)
    op.alter_column('annotation_files', 'file_path', nullable=True)
    
    # Add new columns to annotations table if they don't exist
    annotations_columns = [col['name'] for col in inspector.get_columns('annotations')]
    
    if 'annotation_file_id' not in annotations_columns:
        op.add_column('annotations', sa.Column('annotation_file_id', sa.String(), nullable=True))
    if 'coco_image_id' not in annotations_columns:
        op.add_column('annotations', sa.Column('coco_image_id', sa.Integer(), nullable=True))
    if 'coco_annotation_id' not in annotations_columns:
        op.add_column('annotations', sa.Column('coco_annotation_id', sa.Integer(), nullable=True))
    if 'category_id' not in annotations_columns:
        op.add_column('annotations', sa.Column('category_id', sa.Integer(), nullable=True))
    if 'bbox_x' not in annotations_columns:
        op.add_column('annotations', sa.Column('bbox_x', sa.Float(), nullable=True))
    if 'bbox_y' not in annotations_columns:
        op.add_column('annotations', sa.Column('bbox_y', sa.Float(), nullable=True))
    if 'bbox_width' not in annotations_columns:
        op.add_column('annotations', sa.Column('bbox_width', sa.Float(), nullable=True))
    if 'bbox_height' not in annotations_columns:
        op.add_column('annotations', sa.Column('bbox_height', sa.Float(), nullable=True))
    if 'confidence' not in annotations_columns:
        op.add_column('annotations', sa.Column('confidence', sa.Float(), nullable=True))
    
    # Add foreign key constraint for annotation_file_id in annotations table if it doesn't exist
    try:
        op.create_foreign_key(None, 'annotations', 'annotation_files', ['annotation_file_id'], ['id'])
    except:
        # Foreign key might already exist, ignore error
        pass
    
    # Add indexes for better performance
    try:
        op.create_index(op.f('ix_annotations_annotation_file_id'), 'annotations', ['annotation_file_id'], unique=False)
    except:
        # Index might already exist, ignore error
        pass
    
    try:
        op.create_index(op.f('ix_annotations_bbox'), 'annotations', ['bbox_x', 'bbox_y', 'bbox_width', 'bbox_height'], unique=False)
    except:
        # Index might already exist, ignore error
        pass
    
    try:
        op.create_index(op.f('ix_annotations_category'), 'annotations', ['category'], unique=False)
    except:
        # Index might already exist, ignore error
        pass
    
    # Set default values for new columns
    op.execute("UPDATE annotation_files SET is_processed = false WHERE is_processed IS NULL")
    op.execute("UPDATE annotation_files SET processing_status = 'pending' WHERE processing_status IS NULL")
    op.execute("UPDATE annotations SET confidence = 1.0 WHERE confidence IS NULL")
    
    # Make new columns non-nullable after setting defaults
    op.alter_column('annotation_files', 'is_processed', nullable=False)
    op.alter_column('annotation_files', 'processing_status', nullable=False)
    op.alter_column('annotations', 'confidence', nullable=False)


def downgrade() -> None:
    # Remove indexes
    try:
        op.drop_index(op.f('ix_annotations_category'), table_name='annotations')
        op.drop_index(op.f('ix_annotations_bbox'), table_name='annotations')
        op.drop_index(op.f('ix_annotations_annotation_file_id'), table_name='annotations')
    except:
        pass
    
    # Remove foreign key constraint
    try:
        op.drop_constraint(None, 'annotations', type_='foreignkey')
    except:
        pass
    
    # Drop annotation_classes table
    op.drop_index(op.f('ix_annotation_classes_id'), table_name='annotation_classes')
    op.drop_index(op.f('ix_annotation_classes_class_name'), table_name='annotation_classes')
    op.drop_table('annotation_classes')
    
    # Remove new columns from annotations table
    op.drop_column('annotations', 'confidence')
    op.drop_column('annotations', 'bbox_height')
    op.drop_column('annotations', 'bbox_width')
    op.drop_column('annotations', 'bbox_y')
    op.drop_column('annotations', 'bbox_x')
    op.drop_column('annotations', 'category_id')
    op.drop_column('annotations', 'coco_annotation_id')
    op.drop_column('annotations', 'coco_image_id')
    op.drop_column('annotations', 'annotation_file_id')
    
    # Make file_path non-nullable again
    op.alter_column('annotation_files', 'file_path', nullable=False)
    
    # Remove new columns from annotation_files table
    op.drop_column('annotation_files', 'error_message')
    op.drop_column('annotation_files', 'processing_status')
    op.drop_column('annotation_files', 'is_processed')
