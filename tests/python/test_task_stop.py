"""Tests for cooperative annotation task cancellation."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import Base  # noqa: E402
from app import models  # noqa: E402
from app.task_stop import (  # noqa: E402
    TaskStopped,
    check_task_stop,
    finalize_running_task,
    task_stop_requested,
)


@pytest.fixture()
def db_session(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'task_stop.db'}",
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = Session()
    yield session
    session.close()


def test_task_stop_requested_detects_stopped_status(db_session):
    task = models.Task(
        name="proc",
        task_type="annotation_processing",
        status="stopped",
        project_id=1,
        task_metadata={"stop_requested_at": "2026-01-01T00:00:00"},
    )
    assert task_stop_requested(task) is True


def test_check_task_stop_raises_when_stop_requested(db_session):
    task = models.Task(
        name="proc",
        task_type="annotation_processing",
        status="running",
        project_id=1,
        task_metadata={"stop_requested_at": "2026-01-01T00:00:00"},
    )
    db_session.add(task)
    db_session.commit()

    with pytest.raises(TaskStopped):
        check_task_stop(db_session, task.id)


def test_finalize_running_task_keeps_stopped_status(db_session):
    task = models.Task(
        name="proc",
        task_type="annotation_processing",
        status="stopped",
        project_id=1,
        task_metadata={"stop_requested_at": "2026-01-01T00:00:00"},
        error_message="Task stopped by user",
    )
    db_session.add(task)
    db_session.commit()

    assert finalize_running_task(db_session, task.id) is False
    db_session.refresh(task)
    assert task.status == "stopped"


def test_finalize_running_task_marks_completed(db_session):
    task = models.Task(
        name="proc",
        task_type="annotation_processing",
        status="running",
        project_id=1,
    )
    db_session.add(task)
    db_session.commit()

    assert finalize_running_task(db_session, task.id) is True
    db_session.refresh(task)
    assert task.status == "completed"
    assert task.progress == 100.0
