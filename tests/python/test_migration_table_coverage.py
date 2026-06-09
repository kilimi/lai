"""Ensure every SQLAlchemy model table is created by Alembic migrations."""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_PATH = REPO_ROOT / "backend" / "app" / "models.py"
MIGRATIONS_DIR = REPO_ROOT / "backend" / "migrations" / "versions"

# Tables created via op.create_table in migration upgrade() bodies.
_CREATE_TABLE_RE = re.compile(
    r"""op\.create_table\(\s*['"]([a-z_][a-z0-9_]*)['"]""",
    re.MULTILINE,
)


def _model_tables() -> set[str]:
    text = MODELS_PATH.read_text(encoding="utf-8")
    return set(re.findall(r'__tablename__\s*=\s*["\']([a-z_][a-z0-9_]*)["\']', text))


def _migration_create_tables() -> set[str]:
    found: set[str] = set()
    for path in sorted(MIGRATIONS_DIR.glob("*.py")):
        found.update(_CREATE_TABLE_RE.findall(path.read_text(encoding="utf-8")))
    return found


def test_every_model_table_is_created_in_migrations():
    model_tables = _model_tables()
    migration_tables = _migration_create_tables()
    missing = sorted(model_tables - migration_tables)
    assert not missing, (
        "Model tables without op.create_table in Alembic migrations: "
        + ", ".join(missing)
    )
