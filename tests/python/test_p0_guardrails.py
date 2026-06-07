"""P0 guardrail tests."""
import os
import subprocess
import sys
from pathlib import Path

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


def test_ensure_inline_dispatch_blocked_by_default(monkeypatch):
    monkeypatch.delenv("LAI_ALLOW_INLINE_TASKS", raising=False)
    from app import task_dispatch
    import importlib

    importlib.reload(task_dispatch)
    with pytest.raises(HTTPException) as exc_info:
        task_dispatch.ensure_inline_dispatch_allowed("test feature")
    assert exc_info.value.status_code == 503
    assert "Celery" in str(exc_info.value.detail)


def test_merge_task_metadata_sets_framework_id():
    from app.ml.task_metadata import merge_task_metadata

    meta = merge_task_metadata({"epochs": 10}, framework_id="ultralytics.yolo")
    assert meta["framework_id"] == "ultralytics.yolo"
    assert meta["epochs"] == 10
