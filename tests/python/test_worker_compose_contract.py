"""Docker Compose must define split workers (not only celery_worker)."""
from pathlib import Path

import yaml


def test_compose_defines_worker_general_and_gpu():
    compose_path = Path(__file__).resolve().parents[2] / "dockers" / "backend" / "docker-compose.yml"
    data = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    services = data.get("services", {})
    assert "worker-general" in services
    assert "worker-gpu" in services
    assert "celery-beat" in services
    assert "celery_worker" not in services


def test_code_mount_targets_both_workers():
    mount_path = (
        Path(__file__).resolve().parents[2] / "dockers" / "docker-compose.code-mount.yml"
    )
    data = yaml.safe_load(mount_path.read_text(encoding="utf-8"))
    services = data.get("services", {})
    assert "worker-general" in services
    assert "worker-gpu" in services


def test_app_images_use_docker_deps_additional_context():
    compose_path = Path(__file__).resolve().parents[2] / "dockers" / "backend" / "docker-compose.yml"
    data = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    for name in ("backend", "worker-general", "worker-gpu"):
        build = data["services"][name]["build"]
        assert build["context"].replace("\\", "/").endswith("backend")
        assert build.get("additional_contexts", {}).get("docker_deps") == "."


def test_sam_service_uses_docker_deps_additional_context():
    compose_path = Path(__file__).resolve().parents[2] / "dockers" / "backend" / "docker-compose.yml"
    data = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    build = data["services"]["sam_service"]["build"]
    assert "sam_service" in build["context"].replace("\\", "/")
    assert build.get("additional_contexts", {}).get("docker_deps") == "../../dockers/sam"


def test_worker_gpu_consumes_gpu_and_mmyolo_queues():
    compose_path = Path(__file__).resolve().parents[2] / "dockers" / "backend" / "docker-compose.yml"
    data = yaml.safe_load(compose_path.read_text(encoding="utf-8"))
    gpu = data["services"]["worker-gpu"]
    cmd = " ".join(gpu.get("command", []))
    assert "gpu_app" in cmd
    assert "gpu" in cmd and "mmyolo" in cmd
    env = {e.split("=")[0]: e.split("=", 1)[1] for e in gpu.get("environment", []) if "=" in e}
    assert env.get("ULTRALYTICS_PYTHON") == "/opt/conda/bin/python"
    assert env.get("ULTRALYTICS_SITE") == "/opt/ultralytics-site"
    assert env.get("MMYOLO_PYTHON") == "/opt/conda/envs/mmyolo/bin/python"
    build_args = gpu.get("build", {}).get("args", {})
    assert "ULTRALYTICS_IMAGE" in build_args
    assert "MMYOLO_IMAGE" in build_args
