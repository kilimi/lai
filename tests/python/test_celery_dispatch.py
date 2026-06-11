"""Celery queue routing for training and GPU tasks."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.celery._config import KNOWN_TASK_QUEUES
from app.ml.celery_dispatch import (
    GPU_QUEUE,
    MMYOLO_QUEUE,
    enqueue_training_task,
    send_gpu_task,
)
from app.ml.registry import clear_registry, get_backend


@pytest.fixture(autouse=True)
def _register_backends():
    clear_registry()
    from app.ml.backends import register_all_backends

    register_all_backends()
    yield
    clear_registry()


def test_known_training_queues():
    assert KNOWN_TASK_QUEUES["app.tasks.training_tasks.train_yolo_model"] == GPU_QUEUE
    assert KNOWN_TASK_QUEUES["app.tasks.training_tasks.train_rtdetr_model"] == GPU_QUEUE
    assert KNOWN_TASK_QUEUES["app.tasks.training_tasks.train_mmyolo_model"] == MMYOLO_QUEUE
    assert KNOWN_TASK_QUEUES["app.tasks.evaluation_tasks.evaluate_model"] == GPU_QUEUE
    assert KNOWN_TASK_QUEUES["app.tasks.export_tasks.export_yolo_model"] == GPU_QUEUE


def test_enqueue_training_task_uses_gpu_for_yolo():
    task = MagicMock()
    task.apply_async.return_value = MagicMock(id="celery-1")

    enqueue_training_task(task, 42, {"epochs": 1}, "ultralytics.yolo")
    task.apply_async.assert_called_once_with(args=[42, {"epochs": 1}], queue=GPU_QUEUE)


def test_enqueue_training_task_uses_mmyolo_queue():
    task = MagicMock()
    task.apply_async.return_value = MagicMock(id="celery-2")

    enqueue_training_task(task, 7, {"epochs": 1}, "mmyolo")
    task.apply_async.assert_called_once_with(args=[7, {"epochs": 1}], queue=MMYOLO_QUEUE)


def test_send_gpu_task_uses_gpu_app():
    from app.celery import gpu_app

    with patch.object(gpu_app, "send_task") as mock_send_task:
        mock_send_task.return_value = MagicMock(id="x")
        send_gpu_task("app.tasks.export_tasks.export_yolo_model", args=[1, {}], queue=GPU_QUEUE)
        mock_send_task.assert_called_once_with(
            "app.tasks.export_tasks.export_yolo_model",
            args=[1, {}],
            kwargs={},
            queue=GPU_QUEUE,
        )


def test_backend_runtime_profiles_map_to_worker_queues():
    assert get_backend("ultralytics.yolo").runtime_profile == "ultralytics"
    assert get_backend("mmyolo").runtime_profile == "mmyolo"
