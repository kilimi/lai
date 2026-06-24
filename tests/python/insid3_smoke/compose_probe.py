"""Detect sam_service health and exec commands inside it from the host."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from training_smoke.compose_probe import (
    CONTAINER_TESTS_ROOT,
    _compose_env,
    docker_compose_base_cmd,
    get_service_ps_row,
    host_tests_dir,
    resolve_bundle_root,
)

SAM_SERVICE = "sam_service"


def is_inside_sam_service_container() -> bool:
    """True when pytest or a helper script runs inside sam_service."""
    if os.environ.get("LAI_INSID3_SMOKE_IN_CONTAINER", "").lower() in ("1", "true", "yes"):
        return True
    return Path("/app/app.py").is_file() and Path("/opt/insid3").is_dir()


def sam_service_status(*, bundle_root: Optional[Path] = None) -> Dict[str, Any]:
    try:
        row = get_service_ps_row(SAM_SERVICE, bundle_root=bundle_root)
    except FileNotFoundError as exc:
        return {
            "running": False,
            "healthy": False,
            "state": None,
            "health": None,
            "error": str(exc),
        }

    if not row:
        return {
            "running": False,
            "healthy": False,
            "state": None,
            "health": None,
            "error": (
                f"{SAM_SERVICE} is not running (start stack with COMPOSE_PROFILES=gpu)"
            ),
        }

    state = (row.get("State") or row.get("Status") or "").lower()
    health = (row.get("Health") or "").lower()
    running = "running" in state
    healthy = running and (health in ("", "healthy") or health == "healthy")
    if running and health == "unhealthy":
        healthy = False

    return {
        "running": running,
        "healthy": healthy,
        "state": state,
        "health": health or None,
        "error": None if healthy else f"{SAM_SERVICE} state={state!r} health={health!r}",
    }


def sam_service_has_tests_mount(*, bundle_root: Optional[Path] = None) -> bool:
    proc = exec_sam_service(
        ["test", "-f", f"{CONTAINER_TESTS_ROOT}/python/insid3_smoke/run_same_image.py"],
        bundle_root=bundle_root,
        use_run=False,
    )
    return proc.returncode == 0


def require_sam_service_running() -> None:
    import pytest

    if is_inside_sam_service_container():
        return

    try:
        status = sam_service_status()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))

    if not status["running"]:
        pytest.skip(status["error"] or f"{SAM_SERVICE} is not running")
    if not status["healthy"]:
        pytest.skip(status["error"] or f"{SAM_SERVICE} is not healthy")


def exec_sam_service(
    args: Sequence[str],
    *,
    bundle_root: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 600,
    stdin: Optional[str] = None,
    mount_host_tests: bool = False,
    use_run: Optional[bool] = None,
) -> subprocess.CompletedProcess:
    """
    Run a command inside sam_service.

    Prefer ``exec`` on the running container. ``run`` is only used when
    ``use_run=True`` and bind-mounts ``tests`` at ``/tests`` (older compose
    without ``--no-build`` support).
    """
    root = bundle_root or resolve_bundle_root()
    exec_env = _compose_env()
    if env:
        exec_env.update(env)

    run_mode = use_run
    if run_mode is None:
        run_mode = mount_host_tests and not sam_service_has_tests_mount(bundle_root=root)

    common = [
        "-T",
        "-e",
        "LAI_INSID3_SMOKE_IN_CONTAINER=1",
        "-w",
        "/app",
    ]
    tests_mount: List[str] = []
    if mount_host_tests:
        host_tests = host_tests_dir()
        tests_mount = ["-v", f"{host_tests.as_posix()}:{CONTAINER_TESTS_ROOT}:ro"]

    if run_mode:
        # Avoid --no-build / --pull (not supported on older Docker Compose).
        cmd = [
            *docker_compose_base_cmd(root),
            "run",
            "--rm",
            *common,
            *tests_mount,
            SAM_SERVICE,
            *args,
        ]
    else:
        cmd = [
            *docker_compose_base_cmd(root),
            "exec",
            *common,
            SAM_SERVICE,
            *args,
        ]

    return subprocess.run(
        cmd,
        cwd=root,
        env=exec_env,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def container_script_path(relative: str) -> str:
    """Path inside sam_service when ``tests`` is mounted at ``/tests``."""
    rel = relative.lstrip("/")
    return f"{CONTAINER_TESTS_ROOT}/{rel}"


def exec_sam_service_script(
    script_host_path: Path,
    script_args: Sequence[str],
    *,
    bundle_root: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess:
    """Run a host Python script inside sam_service via ``python -`` (stdin)."""
    script = script_host_path.read_text(encoding="utf-8")
    return exec_sam_service(
        ["python", "-", *script_args],
        bundle_root=bundle_root,
        env=env,
        timeout=timeout,
        stdin=script,
        mount_host_tests=False,
    )
