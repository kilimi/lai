from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv
import os

load_dotenv()

# Use the environment variable or default to the Docker service URL
SQLALCHEMY_DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@db/lai_db"
)

# Create engine with increased pool size and better connection management
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_size=10,          # Reasonable pool size for most workloads
    max_overflow=20,       # Allow overflow for peak loads
    pool_timeout=30,       # Timeout for getting connection from pool
    pool_recycle=1800,     # Recycle connections every 30 minutes (prevent stale connections)
    pool_pre_ping=True,    # Verify connections before use (prevents connection errors)
    echo=False,            # Set to True for SQL query logging
    connect_args={
        "connect_timeout": 10,  # PostgreSQL connection timeout
        "keepalives": 1,        # Enable TCP keepalives
        "keepalives_idle": 30,  # Start keepalives after 30s of idle
        "keepalives_interval": 10,  # Send keepalive every 10s
        "keepalives_count": 5,  # Max keepalive packets before considering connection dead
    }
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()