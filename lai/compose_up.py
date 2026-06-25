"""Start the compose stack and reconcile health-gated services (e.g. web UI)."""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from lai.compose_build import _compose_base_cmd
from lai.compose_pull import compose_profiles

# Services that only start after another service passes its healthcheck.
_HEALTH_GATED: tuple[tuple[str, str], ...] = (("web", "backend"),)

_DEFAULT_WAIT_TIMEOUT_S = 600
_POLL_INTERVAL_S = 2.0


def _run(cmd: list[str], root: Path) -> int:
    print(f"+ cd {root} && {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=root).returncode


def _compose_cmd(root: Path) -> list[str]:
    cmd = _compose_base_cmd(root)
    for profile in compose_profiles(root):
        cmd.extend(["--profile", profile])
    return cmd


def _service_container_id(root: Path, service: str) -> str | None:
    cmd = _compose_cmd(root) + ["ps", "-q", service]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    line = (proc.stdout or "").strip().splitlines()
    return line[0].strip() if line else None


def service_is_running(root: Path, service: str) -> bool:
    """True when compose reports the service container as running."""
    cid = _service_container_id(root, service)
    if not cid:
        return False
    proc = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", cid],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0 and proc.stdout.strip().lower() == "true"


def container_health_status(root: Path, service: str) -> str | None:
    """Docker health status: healthy, unhealthy, starting, none, or None if absent."""
    cid = _service_container_id(root, service)
    if not cid:
        return None
    proc = subprocess.run(
        [
            "docker",
            "inspect",
            "-f",
            "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            cid,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def wait_for_service_healthy(
    root: Path,
    service: str,
    *,
    timeout_s: int = _DEFAULT_WAIT_TIMEOUT_S,
) -> bool:
    """Poll until the service container is healthy (or has no healthcheck and is running)."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = container_health_status(root, service)
        if status in ("healthy", "none") and service_is_running(root, service):
            return True
        if status == "unhealthy" and not service_is_running(root, service):
            return False
        time.sleep(_POLL_INTERVAL_S)
    return container_health_status(root, service) in ("healthy", "none") and service_is_running(
        root, service
    )


def pending_health_gated_services(root: Path) -> list[str]:
    """Services blocked on a dependency healthcheck that are not running yet."""
    pending: list[str] = []
    for service, depends_on in _HEALTH_GATED:
        if service_is_running(root, service):
            continue
        if _service_container_id(root, depends_on) is None:
            continue
        pending.append(service)
    return pending


def reconcile_health_gated_services(
    root: Path,
    *,
    timeout_s: int = _DEFAULT_WAIT_TIMEOUT_S,
) -> int:
    """
    Ensure health-gated services (web) start after their dependencies are ready.

    ``docker compose up -d`` can finish while backend is still migrating or
    recovering from a first-boot error. Compose does not retroactively start
    dependents when the dependency later becomes healthy.
    """
    pending = pending_health_gated_services(root)
    if not pending:
        return 0

    deps = {dep for svc, dep in _HEALTH_GATED if svc in pending}
    for dep in sorted(deps):
        print(
            f"Waiting for {dep} to become healthy before starting "
            f"{', '.join(s for s, d in _HEALTH_GATED if d == dep and s in pending)}...",
            file=sys.stderr,
            flush=True,
        )
        if not wait_for_service_healthy(root, dep, timeout_s=timeout_s):
            print(
                f"Timed out waiting for {dep} to become healthy. "
                "Check logs: lai compose -- logs {dep}",
                file=sys.stderr,
            )
            return 1

    cmd = _compose_cmd(root) + ["up", "-d", *pending]
    return _run(cmd, root)


def up_stack(
    root: Path,
    extra: list[str] | None = None,
    *,
    wait_timeout_s: int = _DEFAULT_WAIT_TIMEOUT_S,
) -> int:
    """``docker compose up -d`` plus reconciliation for health-gated services."""
    extra = extra or []
    cmd = _compose_cmd(root) + [
        "up",
        "-d",
        "--wait",
        f"--wait-timeout={wait_timeout_s}",
        *extra,
    ]
    rc = _run(cmd, root)
    if rc != 0:
        # Slow first boot (migrations, large pulls) can exceed --wait-timeout.
        print(
            "Compose up did not finish within the wait window; "
            "checking health-gated services...",
            file=sys.stderr,
            flush=True,
        )
    reconcile_rc = reconcile_health_gated_services(root, timeout_s=wait_timeout_s)
    if reconcile_rc != 0:
        return reconcile_rc
    # --wait-timeout is non-fatal when dependents (web) are running.
    if rc != 0 and not pending_health_gated_services(root):
        return 0
    return rc
