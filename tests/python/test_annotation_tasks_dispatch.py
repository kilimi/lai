"""Annotation tasks are registered on the general Celery app."""
from app.celery._config import KNOWN_TASK_QUEUES


def test_annotation_tasks_on_general_queue():
    assert KNOWN_TASK_QUEUES["app.tasks.annotation_tasks.process_annotation_file"] == "general"
    assert KNOWN_TASK_QUEUES["app.tasks.annotation_tasks.merge_annotation_files"] == "general"


def test_annotation_task_names_registered():
    from app.celery.general_app import celery_app

    celery_app.loader.import_default_modules()
    names = set(celery_app.tasks.keys())
    assert "app.tasks.annotation_tasks.process_annotation_file" in names
    assert "app.tasks.annotation_tasks.merge_annotation_files" in names
