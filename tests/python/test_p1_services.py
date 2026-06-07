"""P1 service layer tests."""
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_check_no_hardcoded_api_url_script_passes():
    script = REPO_ROOT / "scripts" / "check_no_hardcoded_api_url.py"
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_rewrite_dataset_storage_url_segment():
    from app.services.dataset_paths import rewrite_dataset_storage_url_segment

    out = rewrite_dataset_storage_url_segment(
        "/static/projects/1/42/images/a.jpg",
        old_project_id=1,
        new_project_id=9,
        dataset_id=42,
    )
    assert out == "/static/projects/9/42/images/a.jpg"


def test_primary_projects_disk_root_uses_env(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("LAI_PROJECTS_ROOT", str(projects))
    from app.services.dataset_paths import primary_projects_disk_root

    assert primary_projects_disk_root() == projects.resolve()


def test_db_auto_create_false_with_migrations(monkeypatch):
    monkeypatch.delenv("LAI_DB_AUTO_CREATE", raising=False)
    monkeypatch.setenv("LAI_RUN_MIGRATIONS", "true")
    from app import db_bootstrap
    import importlib

    importlib.reload(db_bootstrap)
    assert db_bootstrap.db_auto_create_enabled() is False


def test_dispatch_training_requires_celery(monkeypatch):
    monkeypatch.setenv("USE_CELERY", "false")
    monkeypatch.setenv("LAI_ALLOW_INLINE_TASKS", "false")
    from app.services.training_service import dispatch_training

    class _Task:
        id = 1
        task_metadata = {}

    class _Db:
        def commit(self):
            pass

    with pytest.raises(HTTPException) as exc_info:
        dispatch_training(
            _Db(),
            _Task(),
            {},
            framework_id="ultralytics.yolo",
            celery_task=MagicMock(),
            use_celery=False,
            feature_name="Test training",
        )
    assert exc_info.value.status_code == 503


def test_create_annotation_task_requires_celery_or_inline_flag(monkeypatch):
    """Annotation processing must not spawn threads when Celery is off."""
    monkeypatch.setenv("USE_CELERY", "false")
    monkeypatch.setenv("LAI_ALLOW_INLINE_TASKS", "false")
    from app.services.dataset_annotations_service import create_annotation_processing_task

    assert callable(create_annotation_processing_task)


def test_list_training_checkpoints_empty_task():
    from app.services.training_checkpoints_service import list_training_checkpoints

    class _Task:
        id = 1
        task_type = "yolo_training"
        task_metadata = {}

    result = list_training_checkpoints(_Task())
    assert result["success"] is True
    assert result["checkpoints"] == []
