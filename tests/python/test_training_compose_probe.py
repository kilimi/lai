"""Unit tests for training_smoke Docker compose probing (no real stack required)."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from training_smoke.compose_probe import (
    docker_compose_base_cmd,
    is_inside_worker_container,
    resolve_bundle_root,
    worker_gpu_status,
)


def test_resolve_bundle_root_from_env(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "docker-compose.yml").write_text("name: test\n")
    monkeypatch.setenv("LAI_COMPOSE_PROJECT_DIR", str(repo))
    assert resolve_bundle_root() == repo.resolve()


def test_docker_compose_base_cmd_includes_compose_file(tmp_path, monkeypatch):
    repo = tmp_path / "proj"
    repo.mkdir()
    (repo / "docker-compose.yml").write_text("services: {}\n")
    monkeypatch.setenv("LAI_COMPOSE_PROJECT_DIR", str(repo))
    cmd = docker_compose_base_cmd(repo)
    assert cmd[:2] == ["docker", "compose"]
    assert "-f" in cmd
    assert str(repo / "docker-compose.yml") in cmd


def test_worker_gpu_status_healthy(monkeypatch, tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    (repo / "docker-compose.yml").write_text("services: {}\n")
    monkeypatch.setenv("LAI_COMPOSE_PROJECT_DIR", str(repo))

    row = json.dumps({"State": "running", "Health": "healthy"})
    mock_proc = MagicMock(returncode=0, stdout=row + "\n", stderr="")
    with patch("training_smoke.compose_probe.subprocess.run", return_value=mock_proc):
        status = worker_gpu_status(bundle_root=repo)

    assert status["running"] is True
    assert status["healthy"] is True


def test_worker_gpu_status_not_running(monkeypatch, tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    (repo / "docker-compose.yml").write_text("services: {}\n")
    monkeypatch.setenv("LAI_COMPOSE_PROJECT_DIR", str(repo))

    mock_proc = MagicMock(returncode=0, stdout="", stderr="")
    with patch("training_smoke.compose_probe.subprocess.run", return_value=mock_proc):
        status = worker_gpu_status(bundle_root=repo)

    assert status["running"] is False
    assert status["healthy"] is False


def test_is_inside_worker_container_env(monkeypatch):
    monkeypatch.setenv("LAI_TRAINING_SMOKE_IN_CONTAINER", "1")
    assert is_inside_worker_container() is True
