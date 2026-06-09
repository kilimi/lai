"""Ensure pipelines and worker_gpu_status exist (repair empty / missing migrations)

Revision ID: ensure_missing_model_tables
Revises: ensure_image_collections_table
Create Date: 2026-06-08
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "ensure_missing_model_tables"
down_revision: Union[str, None] = "ensure_image_collections_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    return inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if not _has_table("pipelines"):
        op.create_table(
            "pipelines",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("project_id", sa.Integer(), nullable=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("nodes", sa.JSON(), nullable=True),
            sa.Column("edges", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_pipelines_id", "pipelines", ["id"], unique=False)
        op.create_index("ix_pipelines_name", "pipelines", ["name"], unique=False)
        op.create_index("ix_pipelines_project_id", "pipelines", ["project_id"], unique=False)

    if not _has_table("worker_gpu_status"):
        op.create_table(
            "worker_gpu_status",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("has_gpu", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("gpu_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("gpus", sa.JSON(), nullable=False),
            sa.Column("memory_used_mb", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("memory_total_mb", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("source", sa.String(), nullable=False, server_default="celery_worker"),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )


def downgrade() -> None:
    pass
