"""Ensure image_collections exists (repair 5310e9164122 gap on stamped DBs)

Revision ID: ensure_image_collections_table
Revises: a1b2c3d4e5f6
Create Date: 2026-06-08

Fresh PyPI/Docker installs rely on Alembic only (LAI_DB_AUTO_CREATE=false). An earlier
revision added a foreign key to image_collections without creating the table. Dev installs
masked this via create_all(). This revision is idempotent for DBs already at head.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "ensure_image_collections_table"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    return inspect(op.get_bind()).has_table(name)


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if not _has_table("image_collections"):
        op.create_table(
            "image_collections",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("dataset_id", sa.Integer(), nullable=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("is_default", sa.Boolean(), nullable=True),
            sa.Column("position", sa.Integer(), server_default="0", nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["dataset_id"], ["datasets.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_image_collections_id", "image_collections", ["id"], unique=False)
        op.create_index(
            "ix_image_collections_dataset_id", "image_collections", ["dataset_id"], unique=False
        )
        op.create_index("ix_image_collections_name", "image_collections", ["name"], unique=False)

    if _has_table("images") and not _has_column("images", "collection_id"):
        op.add_column("images", sa.Column("collection_id", sa.Integer(), nullable=True))
        op.create_index("ix_images_collection_id", "images", ["collection_id"], unique=False)
        if _has_table("image_collections"):
            op.create_foreign_key(
                "fk_images_collection_id_image_collections",
                "images",
                "image_collections",
                ["collection_id"],
                ["id"],
            )


def downgrade() -> None:
    # Repair-only migration; no downgrade.
    pass
