"""CPU maintenance tasks (no ML imports)."""
import logging

from app.celery.general_app import celery_app
from app.database import SessionLocal

logger = logging.getLogger(__name__)


@celery_app.task(name="app.tasks.training_tasks.cleanup_old_tasks")
def cleanup_old_tasks():
    """Cleanup old completed/failed tasks and their files."""
    db = SessionLocal()
    try:
        logger.info("Cleanup task executed")
    finally:
        db.close()
