from unittest.mock import MagicMock, patch

from sqlalchemy.exc import OperationalError

from app.tasks import task_monitoring


def test_is_transient_db_error_detects_postgres_startup():
    exc = OperationalError("stmt", {}, Exception("FATAL: the database system is starting up"))
    assert task_monitoring._is_transient_db_error(exc) is True


def test_auto_cancel_stale_tasks_skips_when_database_starting():
    db = MagicMock()
    db.query.side_effect = OperationalError(
        "stmt",
        {},
        Exception("FATAL: the database system is starting up"),
    )
    session_local = MagicMock(return_value=db)

    with patch.object(task_monitoring, "SessionLocal", session_local):
        result = task_monitoring.auto_cancel_stale_tasks()

    assert result == {
        "success": False,
        "skipped": True,
        "reason": "database_unavailable",
    }
    db.rollback.assert_called_once()
    db.close.assert_called_once()
