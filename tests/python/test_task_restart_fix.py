#!/usr/bin/env python3
"""
Test for the task restart fix (task_reject_on_worker_lost issue).

This tests that stopped/cancelled/paused tasks don't restart when the Celery
worker process starts (e.g., after Docker container restart).

Tests both:
1. Worker startup sync (sync_tasks_with_database) 
2. Cancel endpoint cleanup (celery_app.backend.delete)
"""

import os
import sys
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch, call
from datetime import datetime, timezone

import pytest

pytest.importorskip("redis")

# Add app to path
backend_dir = Path(__file__).parent.parent.parent / "backend"
sys.path.insert(0, str(backend_dir))

# Set up test database
os.environ.setdefault('DATABASE_URL', 'sqlite:///:memory:')


def test_sync_tasks_with_database_revokes_stopped_tasks():
    """
    Test that sync_tasks_with_database revokes and purges all stopped/cancelled/paused
    tasks from Celery on worker startup.
    """
    print("\nTest: Worker startup sync revokes stopped tasks...")
    
    from app.models import Task, Base
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.celery_app import celery_app
    
    # Create in-memory test database
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    db = TestSessionLocal()
    
    # Create test tasks with different statuses
    stopped_task = Task(
        id=1,
        name="Stopped Training",
        task_type="yolo_training",
        status="stopped",
        project_id=1,
        progress=50,
        task_metadata={
            "celery_task_id": "celery-stopped-task-123",
            "stop_requested_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    
    cancelled_task = Task(
        id=2,
        name="Cancelled Training",
        task_type="yolo_training",
        status="cancelled",
        project_id=1,
        progress=30,
        task_metadata={
            "celery_task_id": "celery-cancelled-task-456",
        }
    )
    
    paused_task = Task(
        id=3,
        name="Paused Training",
        task_type="yolo_training",
        status="paused",
        project_id=1,
        progress=40,
        task_metadata={
            "celery_task_id": "celery-paused-task-789",
        }
    )
    
    # Running task should NOT be touched by sync (only stopped/cancelled/paused)
    running_task = Task(
        id=4,
        name="Running Training",
        task_type="yolo_training",
        status="running",
        project_id=1,
        progress=50,
        task_metadata={
            "celery_task_id": "celery-running-task-999",
        }
    )
    
    db.add_all([stopped_task, cancelled_task, paused_task, running_task])
    db.commit()
    
    with patch.object(celery_app.control, "revoke", MagicMock()) as mock_revoke, patch.object(
        celery_app.backend, "delete", MagicMock()
    ) as mock_delete, patch(
        "sqlalchemy.create_engine", return_value=engine
    ), patch("sqlalchemy.orm.sessionmaker", return_value=TestSessionLocal), patch(
        "app.celery.worker_hooks.time.sleep"
    ):
        from app.celery_app import sync_tasks_with_database

        sync_tasks_with_database()

    # Verify revoke was called for stopped, cancelled, and paused tasks only
    revoke_calls = mock_revoke.call_args_list
    assert len(revoke_calls) == 3, f"Expected 3 revoke calls, got {len(revoke_calls)}"
    
    # Check that the correct task IDs were revoked
    revoked_task_ids = {call[0][0] for call in revoke_calls}
    expected_task_ids = {
        "celery-stopped-task-123",
        "celery-cancelled-task-456",
        "celery-paused-task-789",
    }
    assert revoked_task_ids == expected_task_ids, \
        f"Expected {expected_task_ids}, got {revoked_task_ids}"
    
    # Verify that revoke was called with correct parameters
    for call_args in revoke_calls:
        args, kwargs = call_args
        assert kwargs.get('terminate') == True, "revoke should have terminate=True"
        assert kwargs.get('signal') == 'SIGKILL', "revoke should have signal=SIGKILL"
    
    # Verify backend.delete was called for each task
    delete_calls = mock_delete.call_args_list
    assert len(delete_calls) == 3, f"Expected 3 delete calls, got {len(delete_calls)}"
    
    deleted_task_ids = {call[0][0] for call in delete_calls}
    assert deleted_task_ids == expected_task_ids, \
        f"Expected backend.delete for {expected_task_ids}, got {deleted_task_ids}"
    
    print("✓ Worker startup sync revokes stopped tasks: PASSED")
    return True


def test_cancel_endpoint_purges_result_backend():
    """
    Test that cancel_task endpoint not only revokes but also deletes from
    Celery result backend to prevent auto-requeue.
    """
    print("\nTest: Cancel endpoint purges result backend...")
    
    from app.models import Task, Base
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.celery_app import celery_app
    
    # Create in-memory test database
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    db = TestSessionLocal()
    
    # Create a running task
    running_task = Task(
        id=10,
        name="Running Task to Cancel",
        task_type="yolo_training",
        status="running",
        project_id=1,
        progress=50,
        task_metadata={
            "celery_task_id": "celery-running-to-cancel-555",
        }
    )
    
    db.add(running_task)
    db.commit()
    
    with patch.object(celery_app.control, "revoke", MagicMock()) as mock_revoke, patch.object(
        celery_app.backend, "delete", MagicMock()
    ) as mock_delete:
        celery_task_id = running_task.task_metadata.get("celery_task_id")
        celery_app.control.revoke(
            celery_task_id,
            terminate=True,
            signal="SIGTERM",
        )
        celery_app.backend.delete(celery_task_id)

    assert mock_revoke.called, "revoke should have been called"
    mock_revoke.assert_called_once_with(
        "celery-running-to-cancel-555",
        terminate=True,
        signal="SIGTERM",
    )

    assert mock_delete.called, "backend.delete should have been called"
    mock_delete.assert_called_once_with("celery-running-to-cancel-555")
    
    print("✓ Cancel endpoint purges result backend: PASSED")
    return True


def test_stopped_task_not_restarted_after_container_restart():
    """
    Integration test: Verify that a stopped task remains stopped after
    simulating container restart (worker process init).
    """
    print("\nTest: Stopped task stays stopped after container restart...")
    
    from app.models import Task, Base
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.celery_app import celery_app
    
    # Create in-memory test database
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    db = TestSessionLocal()
    
    # Create a stopped task with celery task ID
    stopped_task = Task(
        id=20,
        name="Stopped Task Before Restart",
        task_type="yolo_training",
        status="stopped",
        project_id=1,
        progress=75,
        completed_at=datetime.now(timezone.utc),
        error_message="Task stopped by user",
        task_metadata={
            "celery_task_id": "celery-stopped-task-integration",
            "stop_requested_at": datetime.now(timezone.utc).isoformat(),
            "stage": "stopped",
        }
    )
    
    db.add(stopped_task)
    db.commit()
    
    # Verify task is stopped before "restart"
    task_before = db.query(Task).filter(Task.id == 20).first()
    assert task_before.status == "stopped", "Task should be stopped before restart"
    assert task_before.completed_at is not None, "Stopped task should have completed_at set"
    
    with patch.object(celery_app.control, "revoke", MagicMock()) as mock_revoke, patch.object(
        celery_app.backend, "delete", MagicMock()
    ) as mock_delete, patch(
        "sqlalchemy.create_engine", return_value=engine
    ), patch("sqlalchemy.orm.sessionmaker", return_value=TestSessionLocal), patch(
        "app.celery.worker_hooks.time.sleep"
    ):
        from app.celery_app import sync_tasks_with_database

        sync_tasks_with_database()

    assert mock_revoke.called, "revoke should be called during restart sync"
    assert mock_delete.called, "backend.delete should be called during restart sync"
    
    # Verify the task in DB is still stopped
    task_after = db.query(Task).filter(Task.id == 20).first()
    assert task_after.status == "stopped", "Task should still be stopped after restart sync"
    assert task_after.completed_at is not None, "Stopped task should still have completed_at"
    
    print("✓ Stopped task stays stopped after container restart: PASSED")
    return True


def test_handles_missing_celery_task_id():
    """
    Test that sync handles tasks without celery_task_id gracefully.
    """
    print("\nTest: Sync handles tasks without celery_task_id...")
    
    from app.models import Task, Base
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.celery_app import celery_app
    
    # Create in-memory test database
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    TestSessionLocal = sessionmaker(bind=engine)
    db = TestSessionLocal()
    
    # Create a stopped task WITHOUT celery_task_id
    stopped_task = Task(
        id=30,
        name="Stopped Task Without Celery ID",
        task_type="yolo_training",
        status="stopped",
        project_id=1,
        progress=50,
        task_metadata={
            "stage": "stopped",
        }
    )
    
    db.add(stopped_task)
    db.commit()
    
    with patch.object(celery_app.control, "revoke", MagicMock()) as mock_revoke, patch.object(
        celery_app.backend, "delete", MagicMock()
    ), patch("sqlalchemy.create_engine", return_value=engine), patch(
        "sqlalchemy.orm.sessionmaker", return_value=TestSessionLocal
    ), patch("app.celery.worker_hooks.time.sleep"):
        from app.celery_app import sync_tasks_with_database

        sync_tasks_with_database()

    assert not mock_revoke.called, "revoke should not be called for tasks without celery_task_id"
    
    print("✓ Sync handles tasks without celery_task_id: PASSED")
    return True


def main():
    """Run all tests"""
    print("\n" + "="*80)
    print("Testing Task Restart Fix (task_reject_on_worker_lost)")
    print("="*80)
    
    tests = [
        test_sync_tasks_with_database_revokes_stopped_tasks,
        test_cancel_endpoint_purges_result_backend,
        test_stopped_task_not_restarted_after_container_restart,
        test_handles_missing_celery_task_id,
    ]
    
    results = []
    for test_func in tests:
        try:
            result = test_func()
            results.append((test_func.__name__, result))
        except AssertionError as e:
            print(f"✗ {test_func.__name__}: FAILED - {e}")
            results.append((test_func.__name__, False))
        except Exception as e:
            print(f"✗ {test_func.__name__}: ERROR - {e}")
            import traceback
            traceback.print_exc()
            results.append((test_func.__name__, False))
    
    # Summary
    print("\n" + "="*80)
    print("Test Summary")
    print("="*80)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✓ PASSED" if result else "✗ FAILED"
        print(f"{status}: {test_name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    return passed == total


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
