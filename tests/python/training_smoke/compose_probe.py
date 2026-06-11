"""Detect Docker Compose stack health and exec commands in worker-gpu from the host."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

WORKER_GPU_SERVICE = "worker-gpu"
DEFAULT_WORKSPACE = "/tmp/lai_training_smoke"
CONTAINER_TESTS_ROOT = "/tests"


def is_inside_worker_container() -> bool:
    """True when pytest runs inside worker-gpu (manual docker compose exec)."""
    if os.environ.get("LAI_TRAINING_SMOKE_IN_CONTAINER", "").lower() in ("1", "true", "yes"):
        return True
    return Path("/app/app").is_dir() and Path("/tests/python").is_dir()


def _is_windows() -> bool:
    return sys.platform == "win32" or os.name == "nt"


def _split_compose_file_value(value: str) -> List[str]:
    raw = (value or "docker-compose.yml").strip().strip('"').strip("'")
    if not raw:
        return ["docker-compose.yml"]
    for sep in (";", ":"):
        if sep in raw:
            parts = [p.strip() for p in raw.split(sep) if p.strip()]
            if parts:
                return parts
    return [raw]


def _compose_file_flag_args(bundle_root: Path, compose_file_value: str) -> List[str]:
    args: List[str] = []
    for name in _split_compose_file_value(compose_file_value):
        args.extend(["-f", str(bundle_root / name)])
    return args


def _read_env_value(bundle_root: Path, key: str) -> Optional[str]:
    candidates = [
        Path(os.environ.get("LAI_ENV_FILE", "").strip() or ""),
        bundle_root / ".env",
        Path.home() / ".config" / "lai" / ".env",
    ]
    for env_path in candidates:
        if not env_path or not env_path.is_file():
            continue
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def resolve_bundle_root() -> Path:
    override = os.environ.get("LAI_COMPOSE_PROJECT_DIR", "").strip()
    if override:
        root = Path(override).expanduser().resolve()
        if (root / "docker-compose.yml").is_file():
            return root

    repo_root = Path(__file__).resolve().parents[3]
    if (repo_root / "docker-compose.yml").is_file():
        return repo_root

    try:
        from lai.paths import get_bundle_root

        return get_bundle_root()
    except ImportError:
        pass

    raise FileNotFoundError(
        "Cannot locate docker-compose.yml. Set LAI_COMPOSE_PROJECT_DIR to the directory "
        "that contains docker-compose.yml (repo root or lai bundle)."
    )


def docker_compose_base_cmd(bundle_root: Optional[Path] = None) -> List[str]:
    root = bundle_root or resolve_bundle_root()
    compose_file = (
        os.environ.get("COMPOSE_FILE", "").strip()
        or _read_env_value(root, "COMPOSE_FILE")
        or "docker-compose.yml"
    )
    cmd = ["docker", "compose", *_compose_file_flag_args(root, compose_file)]
    project = os.environ.get("COMPOSE_PROJECT_NAME", "").strip() or _read_env_value(
        root, "COMPOSE_PROJECT_NAME"
    )
    if project:
        cmd.extend(["-p", project])
    return cmd


def _compose_env() -> Dict[str, str]:
    env = os.environ.copy()
    profiles = env.get("COMPOSE_PROFILES", "").strip()
    if not profiles:
        env["COMPOSE_PROFILES"] = "gpu"
    elif "gpu" not in profiles.split(","):
        env["COMPOSE_PROFILES"] = f"{profiles},gpu"
    return env


def get_service_ps_row(
    service: str = WORKER_GPU_SERVICE,
    *,
    bundle_root: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Return ``docker compose ps --format json`` row for a service, or None."""
    root = bundle_root or resolve_bundle_root()
    cmd = [
        *docker_compose_base_cmd(root),
        "ps",
        service,
        "--format",
        "json",
    ]
    try:
        proc = subprocess.run(
            cmd,
            cwd=root,
            env=_compose_env(),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if proc.returncode != 0:
        return None

    line = proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ""
    if not line:
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def worker_gpu_status(*, bundle_root: Optional[Path] = None) -> Dict[str, Any]:
    """
    Summarize worker-gpu availability for training smoke tests.

    Returns dict with keys: running, healthy, state, health, error.
    """
    try:
        row = get_service_ps_row(WORKER_GPU_SERVICE, bundle_root=bundle_root)
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
            "error": f"{WORKER_GPU_SERVICE} is not running (is COMPOSE_PROFILES=gpu set?)",
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
        "error": None if healthy else f"{WORKER_GPU_SERVICE} state={state!r} health={health!r}",
    }


def host_tests_dir() -> Path:
    """Host ``tests`` directory (bind-mounted to ``/tests`` in the worker)."""
    return Path(__file__).resolve().parent.parent.parent


def worker_gpu_has_tests_mount(*, bundle_root: Optional[Path] = None) -> bool:
    """True when the running worker-gpu container already has ``/tests`` mounted."""
    proc = exec_worker_gpu(
        ["test", "-f", f"{CONTAINER_TESTS_ROOT}/python/training_smoke/check_env.py"],
        bundle_root=bundle_root,
        use_run=False,
    )
    return proc.returncode == 0


def require_worker_gpu_healthy() -> None:
    """Skip pytest when worker-gpu is not running and healthy."""
    import pytest

    if is_inside_worker_container():
        return

    try:
        status = worker_gpu_status()
    except FileNotFoundError as exc:
        pytest.skip(str(exc))

    if not status["running"]:
        pytest.skip(status["error"] or f"{WORKER_GPU_SERVICE} is not running")
    if not status["healthy"]:
        pytest.skip(status["error"] or f"{WORKER_GPU_SERVICE} is not healthy")


def exec_worker_gpu_script(
    script_host_path: Path,
    script_args: Sequence[str],
    *,
    bundle_root: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 7200,
) -> subprocess.CompletedProcess:
    """Run a host Python script inside worker-gpu via ``python -`` (stdin)."""
    script = script_host_path.read_text(encoding="utf-8")
    return exec_worker_gpu(
        [os.environ.get("LAI_WORKER_GPU_PYTHON", "/opt/conda/bin/python"), "-", *script_args],
        bundle_root=bundle_root,
        env=env,
        timeout=timeout,
        stdin=script,
    )


def exec_worker_gpu(
    args: Sequence[str],
    *,
    bundle_root: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    timeout: int = 7200,
    stdin: Optional[str] = None,
    mount_host_tests: bool = False,
    use_run: Optional[bool] = None,
) -> subprocess.CompletedProcess:
    """
    Run a command inside worker-gpu.

    When ``mount_host_tests`` is True, bind-mount host ``tests`` at ``/tests``.
    Uses ``docker compose run --rm`` (``exec`` cannot add volumes). If the running
    worker already has ``/tests``, ``exec`` is used unless ``use_run`` forces run.
    """
    root = bundle_root or resolve_bundle_root()
    exec_env = _compose_env()
    if env:
        exec_env.update(env)

    run_mode = use_run
    if run_mode is None:
        run_mode = mount_host_tests and not worker_gpu_has_tests_mount(bundle_root=root)

    common = [
        "-T",
        "-e",
        "LAI_TRAINING_SMOKE_IN_CONTAINER=1",
        "-e",
        "LAI_BACKEND_DIR=/app",
    ]
    tests_mount: List[str] = []
    if mount_host_tests:
        host_tests = host_tests_dir()
        tests_mount = ["-v", f"{host_tests}:{CONTAINER_TESTS_ROOT}:ro"]

    if run_mode:
        cmd = [
            *docker_compose_base_cmd(root),
            "run",
            "--rm",
            "--no-build",
            "--no-deps",
            "--pull",
            "never",
            *common,
            *tests_mount,
            WORKER_GPU_SERVICE,
            *args,
        ]
    else:
        cmd = [
            *docker_compose_base_cmd(root),
            "exec",
            *common,
            WORKER_GPU_SERVICE,
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
