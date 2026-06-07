"""Tests for ordered compose build helpers."""
from __future__ import annotations

from pathlib import Path

import pytest

from lai.compose_build import (
    _is_local_build_tag,
    _parse_env_file,
    image_tags,
    should_build_stack,
    uses_local_build,
)


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch):
    env = tmp_path / ".env"
    monkeypatch.setattr("lai.paths.resolve_env_file", lambda _root: env)
    return env


def test_is_local_build_tag():
    assert _is_local_build_tag("lai-worker-gpu:local") is True
    assert _is_local_build_tag("docker.io/org/lai-worker-gpu:latest") is False
    assert _is_local_build_tag("ghcr.io/org/repo-worker-gpu:latest") is False


def test_image_tags_defaults(tmp_path: Path, env_file: Path):
    tags = image_tags(tmp_path)
    assert tags["LAI_WORKER_GPU_IMAGE"] == "lai-worker-gpu:local"
    assert tags["LAI_MMYOLO_IMAGE"] == "lai-mmyolo:local"
    assert tags["LAI_CELERY_IMAGE"] == "lai-worker-gpu:local"


def test_image_tags_from_env(tmp_path: Path, env_file: Path):
    env_file.write_text("LAI_WORKER_GPU_IMAGE=docker.io/foo/lai-worker-gpu:main\n")
    tags = image_tags(tmp_path)
    assert tags["LAI_WORKER_GPU_IMAGE"] == "docker.io/foo/lai-worker-gpu:main"


def test_image_tags_legacy_celery_env_maps_to_gpu_worker(tmp_path: Path, env_file: Path):
    env_file.write_text("LAI_CELERY_IMAGE=docker.io/foo/lai-celery:main\n")
    tags = image_tags(tmp_path)
    assert tags["LAI_CELERY_IMAGE"] == "docker.io/foo/lai-celery:main"
    assert tags["LAI_WORKER_GPU_IMAGE"] == "docker.io/foo/lai-celery:main"


def test_uses_local_build_with_defaults(tmp_path: Path, env_file: Path):
    assert uses_local_build(tmp_path) is True


def _registry_env() -> str:
    return "\n".join(
        [
            "LAI_BACKEND_IMAGE=docker.io/x/lai-backend:latest",
            "LAI_WORKER_GPU_IMAGE=docker.io/x/lai-worker-gpu:latest",
            "LAI_WORKER_GENERAL_IMAGE=docker.io/x/lai-worker-general:latest",
            "LAI_ULTRALYTICS_IMAGE=docker.io/x/lai-ultralytics:latest",
            "LAI_MMYOLO_IMAGE=docker.io/x/lai-mmyolo:latest",
            "LAI_FRONTEND_IMAGE=docker.io/x/lai-frontend:latest",
            "LAI_SAM_IMAGE=docker.io/x/lai-sam:latest",
        ]
    )


def test_uses_local_build_with_registry_tags(tmp_path: Path, env_file: Path):
    env_file.write_text(_registry_env())
    assert uses_local_build(tmp_path) is False


def test_should_build_stack_force_respects_registry(tmp_path: Path, env_file: Path):
    env_file.write_text(_registry_env())
    assert should_build_stack(tmp_path, force=True) is False


def test_parse_env_file_ignores_comments(tmp_path: Path, env_file: Path):
    env_file.write_text("# comment\nLAI_DATA_DIR=/data/lai\n")
    parsed = _parse_env_file(tmp_path)
    assert parsed["LAI_DATA_DIR"] == "/data/lai"
