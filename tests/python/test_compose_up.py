"""Tests for compose up / health-gated service reconciliation."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from lai.compose_up import (
    container_health_status,
    pending_health_gated_services,
    reconcile_health_gated_services,
    service_is_running,
    up_stack,
    wait_for_service_healthy,
)


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch):
    env = tmp_path / ".env"
    monkeypatch.setattr("lai.paths.resolve_env_file", lambda _root: env)
    return env


def test_pending_health_gated_services_none_running(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up.service_is_running", return_value=False), patch(
        "lai.compose_up._service_container_id", side_effect=lambda _r, svc: "cid-backend" if svc == "backend" else None
    ):
        assert pending_health_gated_services(tmp_path) == ["web"]


def test_pending_health_gated_services_web_already_up(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up.service_is_running", return_value=True):
        assert pending_health_gated_services(tmp_path) == []


def test_wait_for_service_healthy_succeeds(tmp_path: Path, env_file: Path):
    with patch(
        "lai.compose_up.container_health_status",
        side_effect=["starting", "healthy"],
    ), patch("lai.compose_up.service_is_running", return_value=True):
        assert wait_for_service_healthy(tmp_path, "backend", timeout_s=10) is True


def test_wait_for_service_healthy_times_out(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up.container_health_status", return_value="starting"), patch(
        "lai.compose_up.service_is_running", return_value=True
    ), patch("lai.compose_up.time.sleep"):
        assert wait_for_service_healthy(tmp_path, "backend", timeout_s=0) is False


def test_reconcile_starts_web_after_backend_healthy(tmp_path: Path, env_file: Path):
    calls: list[list[str]] = []

    def fake_run(cmd, cwd):
        calls.append(cmd)
        return MagicMock(returncode=0)

    with patch("lai.compose_up.pending_health_gated_services", return_value=["web"]), patch(
        "lai.compose_up.wait_for_service_healthy", return_value=True
    ), patch("lai.compose_up.subprocess.run", side_effect=fake_run), patch(
        "lai.compose_up._compose_base_cmd", return_value=["docker", "compose"]
    ), patch("lai.compose_up.compose_profiles", return_value=[]):
        rc = reconcile_health_gated_services(tmp_path)
        assert rc == 0
        assert any("up" in cmd and "web" in cmd for cmd in calls)


def test_reconcile_skips_when_nothing_pending(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up.pending_health_gated_services", return_value=[]), patch(
        "lai.compose_up._run"
    ) as run:
        assert reconcile_health_gated_services(tmp_path) == 0
        run.assert_not_called()


def test_up_stack_reconciles_after_wait_timeout(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up._run", return_value=1), patch(
        "lai.compose_up.reconcile_health_gated_services", return_value=0
    ), patch("lai.compose_up.pending_health_gated_services", return_value=[]), patch(
        "lai.compose_up._compose_cmd", return_value=["docker", "compose"]
    ):
        assert up_stack(tmp_path) == 0


def test_service_is_running_uses_docker_inspect(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up._service_container_id", return_value="abc123"), patch(
        "lai.compose_up.subprocess.run",
        return_value=MagicMock(returncode=0, stdout="true\n"),
    ):
        assert service_is_running(tmp_path, "web") is True


def test_container_health_status_none_when_no_container(tmp_path: Path, env_file: Path):
    with patch("lai.compose_up._service_container_id", return_value=None):
        assert container_health_status(tmp_path, "backend") is None
