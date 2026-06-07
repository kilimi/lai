"""Unit tests for training smoke DB patching (no GPU)."""
from __future__ import annotations

from training_smoke.fixtures import create_test_engine, patch_session_local


def test_patch_session_local_redirects_mmyolo_training(tmp_path):
    """MMYOLO training must see tasks created in the pytest SQLite DB."""
    engine, Session = create_test_engine(tmp_path)
    from app.database import Base
    from app.models import Project, Task as TaskModel
    from app.tasks import mmyolo_training

    Base.metadata.create_all(bind=engine)
    db = Session()
    try:
        db.add(Project(id=1, name="p", description=""))
        task = TaskModel(
            project_id=1,
            name="mmyolo patch probe",
            description="",
            task_type="mmyolo_training",
            status="pending",
        )
        db.add(task)
        db.commit()
        db.refresh(task)

        with patch_session_local(Session):
            other = mmyolo_training.SessionLocal()
            try:
                found = other.query(TaskModel).filter(TaskModel.id == task.id).first()
            finally:
                other.close()

        assert found is not None
        assert found.name == "mmyolo patch probe"
    finally:
        db.close()
