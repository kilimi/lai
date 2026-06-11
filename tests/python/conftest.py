import os
import sys

import pytest

from path_utils import resolve_backend_dir

BACKEND_DIR = resolve_backend_dir()

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def integration_tests_enabled() -> bool:
    return os.environ.get("LAI_INTEGRATION_TESTS", "").lower() in ("1", "true", "yes")


def integration_stack_ready() -> bool:
    """True when LAI_INTEGRATION_TESTS=1 and Postgres has the app schema."""
    if not integration_tests_enabled():
        return False
    try:
        from sqlalchemy import inspect, text

        from app.database import engine

        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return inspect(engine).has_table("datasets")
    except Exception:
        return False


requires_integration_stack = pytest.mark.skipif(
    not integration_stack_ready(),
    reason=(
        "Integration tests need LAI_INTEGRATION_TESTS=1, DATABASE_URL pointing at a "
        "running Postgres with migrations applied (datasets table), and dataset fixtures"
    ),
)
