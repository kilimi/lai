import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Get database URL from environment variable
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db/lai_db")
logger.info(f"Connecting to database: {DATABASE_URL}")

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def reset_dataset_id_sequence():
    """
    Resets the primary key sequence for the 'datasets' table to the max current ID.
    """
    db = SessionLocal()
    try:
        logger.info("Resetting 'datasets' table ID sequence...")

        # The SQL command to reset the sequence
        # It sets the next value to be one greater than the current max ID
        sql = text("""
            SELECT setval(
                pg_get_serial_sequence('datasets', 'id'), 
                (SELECT COALESCE(MAX(id), 0) + 1 FROM datasets), 
                false
            );
        """)

        db.execute(sql)
        db.commit()
        
        logger.info("Successfully reset the 'datasets' table ID sequence.")
    except Exception as e:
        logger.error(f"An error occurred while resetting the sequence: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    reset_dataset_id_sequence()
