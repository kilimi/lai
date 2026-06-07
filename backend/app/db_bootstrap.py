"""
Database connectivity at API startup.

Production should use Alembic migrations. ``create_all`` is opt-in via ``LAI_DB_AUTO_CREATE``.
"""
from __future__ import annotations

import logging
import os
import time

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


def db_auto_create_enabled() -> bool:
    """
    Whether to run ``Base.metadata.create_all`` on startup.

    - ``LAI_DB_AUTO_CREATE=true`` → create tables (dev / greenfield)
    - ``LAI_DB_AUTO_CREATE=false`` → only wait for DB (production with Alembic)
    - unset + ``LAI_RUN_MIGRATIONS=true`` → ``false`` (Compose / production)
    - unset otherwise → ``true`` (legacy host dev without Alembic)
    """
    raw = os.environ.get("LAI_DB_AUTO_CREATE", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    if _env_truthy("LAI_RUN_MIGRATIONS"):
        return False
    return True


def wait_for_database(
    engine: Engine,
    metadata,
    *,
    max_attempts: int = 30,
    sleep_seconds: float = 2.0,
) -> None:
    """Wait until the database accepts connections; optionally create tables."""
    auto_create = db_auto_create_enabled()
    if not auto_create:
        logger.info(
            "LAI_DB_AUTO_CREATE=false: skipping create_all; apply Alembic migrations before starting API"
        )

    for attempt in range(1, max_attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            if auto_create:
                metadata.create_all(bind=engine)
                logger.info("Database schema ensured via create_all (LAI_DB_AUTO_CREATE enabled)")
            return
        except Exception as exc:
            logger.warning("DB not ready (attempt %d/%d): %s", attempt, max_attempts, exc)
            if attempt == max_attempts:
                raise
            time.sleep(sleep_seconds)
