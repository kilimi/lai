"""Dataset duplicate must route to the general queue."""
from unittest.mock import MagicMock, patch

from app.celery._config import KNOWN_TASK_QUEUES


def test_duplicate_dataset_routes_to_general():
    assert KNOWN_TASK_QUEUES["app.tasks.dataset_tasks.duplicate_dataset"] == "general"


@patch("app.tasks.dataset_tasks.duplicate_dataset_task.delay")
def test_duplicate_delay_uses_task(mock_delay):
    mock_delay.return_value = MagicMock(id="celery-1")
    from app.tasks.dataset_tasks import duplicate_dataset_task

    duplicate_dataset_task.delay(1, 2)
    mock_delay.assert_called_once_with(1, 2)
