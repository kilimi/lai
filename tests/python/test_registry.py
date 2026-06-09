"""Tests for pull-only distribution registry helpers."""
from __future__ import annotations

from pathlib import Path

import pytest

from lai.compose_build import uses_local_build
from lai.registry import (
    _embedded_registry_org,
    _org_from_image_ref,
    default_bundle_url,
    fetch_dockerhub_latest_tag,
    gpu_tier_enabled,
    is_developer_checkout,
    registry_image_tag,
    registry_image_tags,
    registry_org,
    resolve_release_version,
    write_registry_env,
)


def test_org_from_image_ref():
    assert _org_from_image_ref("docker.io/luluray/lai-backend:0.1.0") == "luluray"
    assert _org_from_image_ref("luluray/lai-backend:0.1.0") == "luluray"


def test_registry_org_defaults_to_luluray(monkeypatch):
    monkeypatch.delenv("LAI_DOCKERHUB_USER", raising=False)
    monkeypatch.delenv("LAI_GHCR_ORG", raising=False)
    monkeypatch.setattr("lai.registry._embedded_registry_org", lambda: None)
    assert registry_org() == "luluray"


def test_embedded_registry_org_from_bundle_example(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / ".env.example").write_text(
        "LAI_BACKEND_IMAGE=docker.io/luluray/lai-backend:0.1.0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("lai.paths.embedded_bundle_dir", lambda: bundle)
    assert _embedded_registry_org() == "luluray"


def test_registry_image_tag_format_dockerhub(monkeypatch):
    monkeypatch.delenv("LAI_REGISTRY", raising=False)
    monkeypatch.setenv("LAI_DOCKERHUB_USER", "myorg")
    tag = registry_image_tag("LAI_BACKEND_IMAGE", "1.2.3")
    assert tag == "docker.io/myorg/lai-backend:1.2.3"


def test_registry_image_tag_format_ghcr(monkeypatch):
    monkeypatch.setenv("LAI_REGISTRY", "ghcr.io")
    monkeypatch.setenv("LAI_GHCR_ORG", "myorg")
    tag = registry_image_tag("LAI_BACKEND_IMAGE", "1.2.3")
    assert tag == "ghcr.io/myorg/lai-backend:1.2.3"


def test_registry_image_tags_all_keys():
    tags = registry_image_tags("0.1.0")
    assert "LAI_BACKEND_IMAGE" in tags
    assert "LAI_SAM_IMAGE" in tags
    assert all(":" in v for v in tags.values())


def test_default_bundle_url_uses_release_asset():
    url = default_bundle_url("1.0.0")
    assert "releases/download/v1.0.0/lai-dist-1.0.0.tar.gz" in url


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch):
    env = tmp_path / ".env"
    monkeypatch.setattr("lai.paths.resolve_env_file", lambda _root: env)
    return env


def test_uses_local_build_only_configured_keys(tmp_path: Path, env_file: Path):
    env_file.write_text(
        "LAI_BACKEND_IMAGE=docker.io/x/lai-backend:1.0.0\n"
        "LAI_WORKER_GPU_IMAGE=docker.io/x/lai-worker-gpu:1.0.0\n"
        "LAI_WORKER_GENERAL_IMAGE=docker.io/x/lai-worker-general:1.0.0\n"
        "LAI_FRONTEND_IMAGE=docker.io/x/lai-frontend:1.0.0\n"
        "LAI_SAM_IMAGE=docker.io/x/lai-sam:1.0.0\n"
        "LAI_ULTRALYTICS_IMAGE=docker.io/x/lai-ultralytics:1.0.0\n"
        "LAI_MMYOLO_IMAGE=docker.io/x/lai-mmyolo:1.0.0\n"
    )
    assert uses_local_build(tmp_path) is False


def test_gpu_tier_enabled_from_env():
    assert gpu_tier_enabled({"LAI_GPU_TIER": "1"}) is True
    assert gpu_tier_enabled({"COMPOSE_PROFILES": "gpu"}) is True
    assert gpu_tier_enabled({"LAI_GPU_TIER": "0"}) is False


def test_fetch_dockerhub_latest_tag_picks_highest_semver(monkeypatch):
    pages = [
        {
            "results": [
                {"name": "0.1.0"},
                {"name": "0.2.0"},
                {"name": "latest"},
            ],
            "next": None,
        }
    ]

    def fake_urlopen(req, timeout=15.0):
        import json as _json
        from io import BytesIO

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return _json.dumps(pages.pop(0)).encode("utf-8")

        return Resp()

    monkeypatch.setattr("lai.registry.urllib.request.urlopen", fake_urlopen)
    assert fetch_dockerhub_latest_tag("luluray") == "0.2.0"


def test_fetch_dockerhub_latest_tag_falls_back_to_latest(monkeypatch):
    def fake_urlopen(req, timeout=15.0):
        import json as _json
        from io import BytesIO

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return _json.dumps(
                    {"results": [{"name": "latest"}], "next": None}
                ).encode("utf-8")

        return Resp()

    monkeypatch.setattr("lai.registry.urllib.request.urlopen", fake_urlopen)
    assert fetch_dockerhub_latest_tag("luluray") == "latest"


def test_resolve_release_version_uses_dockerhub_when_auto(monkeypatch):
    monkeypatch.setattr("lai.registry.fetch_dockerhub_latest_tag", lambda org: "9.9.9")
    monkeypatch.setattr("lai.registry.registry_org", lambda: "luluray")
    assert resolve_release_version({"LAI_RELEASE_VERSION": "0.1.0"}) == "9.9.9"


def test_resolve_release_version_respects_pin(monkeypatch):
    monkeypatch.setattr("lai.registry.fetch_dockerhub_latest_tag", lambda org: "9.9.9")
    assert (
        resolve_release_version(
            {"LAI_PIN_DOCKER_VERSION": "1", "LAI_RELEASE_VERSION": "0.1.0"}
        )
        == "0.1.0"
    )


def test_resolve_release_version_skips_hub_when_auto_disabled(monkeypatch):
    monkeypatch.setattr("lai.registry.fetch_dockerhub_latest_tag", lambda org: "9.9.9")
    assert (
        resolve_release_version(
            {"LAI_AUTO_DOCKER_LATEST": "0", "LAI_RELEASE_VERSION": "0.1.0"}
        )
        == "0.1.0"
    )


def test_write_registry_env_uses_hub_version(tmp_path: Path, monkeypatch):
    env_file = tmp_path / ".env"
    monkeypatch.setattr("lai.registry.fetch_dockerhub_latest_tag", lambda org: "2.0.0")
    monkeypatch.setattr("lai.registry.registry_org", lambda: "luluray")
    write_registry_env(env_file, gpu_tier=False)
    text = env_file.read_text(encoding="utf-8")
    assert "LAI_RELEASE_VERSION=2.0.0" in text
    assert "docker.io/luluray/lai-backend:2.0.0" in text


def test_is_developer_checkout_with_repo_root(tmp_path: Path, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text("include: []\n")
    (tmp_path / "backend").mkdir()
    monkeypatch.setattr("lai.paths._package_dir", lambda: tmp_path / "lai")
    (tmp_path / "lai").mkdir()
    assert is_developer_checkout(tmp_path) is True
