"""Model-declared composite indexes must appear in Alembic migrations."""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_PATH = REPO_ROOT / "backend" / "app" / "models.py"
MIGRATIONS_DIR = REPO_ROOT / "backend" / "migrations" / "versions"

_INDEX_RE = re.compile(
    r"""Index\(\s*['"]([a-z_][a-z0-9_]*)['"]""",
    re.MULTILINE,
)
_CREATE_INDEX_RE = re.compile(
    r"""(?:op\.create_index|create_index)\(\s*['"]([a-z_][a-z0-9_]*)['"]""",
    re.MULTILINE,
)
# c4d5e6f7a8b9 declares indexes as ("table", "name", (...)) tuples
_INDEX_TUPLE_RE = re.compile(
    r"""\(\s*['"][a-z_][a-z0-9_]*['"]\s*,\s*['"]([a-z_][a-z0-9_]*)['"]\s*,""",
    re.MULTILINE,
)


def _model_index_names() -> set[str]:
    return set(_INDEX_RE.findall(MODELS_PATH.read_text(encoding="utf-8")))


def _migration_index_names() -> set[str]:
    found: set[str] = set()
    for path in MIGRATIONS_DIR.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        found.update(_CREATE_INDEX_RE.findall(text))
        found.update(_INDEX_TUPLE_RE.findall(text))
    return found


def test_model_composite_indexes_exist_in_migrations():
    model_ix = _model_index_names()
    migration_ix = _migration_index_names()
    missing = sorted(model_ix - migration_ix)
    assert not missing, (
        "Composite indexes in models.py missing from Alembic migrations: "
        + ", ".join(missing)
    )
