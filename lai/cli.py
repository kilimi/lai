from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import lai
from lai.compose_build import build_stack, missing_runtime_images, should_build_stack, uses_local_build
from lai.compose_pull import missing_registry_images, pull_stack
from lai.compose_files import ensure_compose_env
from lai.paths import _candidate_repo_root, bundle_data_dir, config_dir, get_bundle_root, resolve_env_file
from lai.uninstall import run_uninstall
from lai.wizard import run_wizard


def _guided_setup_done(root: Path) -> bool:
    """Return True when guided install has created a usable .env."""
    env_p = resolve_env_file(root)
    if not env_p.is_file():
        return False
    try:
        for line in env_p.read_text(encoding="utf-8", errors="ignore").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("LAI_DATA_DIR="):
                value = s.split("=", 1)[1].strip().strip('"').strip("'")
                return bool(value)
    except OSError:
        return False
    return False

def _hint_guided_install(root: Path) -> None:
    if _guided_setup_done(root):
        return
    print(
        "Tip: guided setup not done yet. Run one of:\n"
        "  lai install-gui   # browser wizard on http://127.0.0.1:...\n"
        "  lai install       # terminal (incl. SAM 3 checkpoint prompt)\n"
        "Then: lai up",
        file=sys.stderr,
    )


def _run(cmd: list[str], cwd: Path) -> int:
    if cmd[:2] == ["docker", "compose"]:
        from lai.compose_build import _compose_base_cmd

        full = _compose_base_cmd(cwd) + cmd[2:]
        print(f"+ cd {cwd} && {' '.join(full)}", file=sys.stderr)
        return subprocess.run(full, cwd=cwd).returncode
    print(f"+ cd {cwd} && {' '.join(cmd)}", file=sys.stderr)
    return subprocess.run(cmd, cwd=cwd).returncode


def _find_bash() -> str | None:
    for name in ("bash",):
        path = shutil.which(name)
        if path:
            return path
    return None


def cmd_doctor(_: argparse.Namespace) -> int:
    root = get_bundle_root()
    print(f"lai {lai.__version__}")
    print(f"bundle root: {root}")
    print(f"config dir: {config_dir()}")
    print(f"env file: {resolve_env_file(root)}")
    print(f"editable/source checkout: {_candidate_repo_root() is not None}")
    cached = bundle_data_dir()
    print(f"cache dir (PyPI installs): {cached}")
    if shutil.which("docker"):
        subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"], check=False)
    else:
        print("docker: not found", file=sys.stderr)
    if shutil.which("docker"):
        subprocess.run(["docker", "compose", "version"], check=False)
    if _guided_setup_done(root):
        print("guided setup: yes (.env has LAI_DATA_DIR)")
    else:
        print("guided setup: no — run: lai install")
    env_p = resolve_env_file(root)
    if env_p.is_file():
        try:
            raw = env_p.read_text()
            if "COMPOSE_FILE=" not in raw and (root / "docker-compose.code-mount.yml").is_file():
                print(
                    "compose: .env has no COMPOSE_FILE — host backend bind may be off. "
                    "Re-run: lai install   (sets docker-compose.code-mount.yml + LAI_REPO_ROOT)",
                    file=sys.stderr,
                )
        except OSError:
            pass
    return 0


def cmd_bundle_path(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    print(root)
    return 0


def cmd_install(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    bash = _find_bash()
    if not bash:
        print(
            "bash is required to run scripts/install.sh. On Windows, use Git Bash or WSL.",
            file=sys.stderr,
        )
        return 1
    script = root / "scripts" / "install.sh"
    if not script.is_file():
        print(f"Missing {script}", file=sys.stderr)
        return 1
    env_file = resolve_env_file(root)
    cmd = [bash, str(script)]
    if ns.yes:
        cmd.append("--yes")
    if getattr(ns, "bind_code", False):
        cmd.append("--bind-code")
    if getattr(ns, "no_bind_code", False):
        cmd.append("--no-bind-code")
    env = os.environ.copy()
    env["ENV_FILE"] = str(env_file)
    print(f"+ cd {root} && ENV_FILE={env_file} {' '.join(cmd)}", file=sys.stderr)
    p = subprocess.run(cmd, cwd=root, env=env)
    return p.returncode


def cmd_install_gui(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    return run_wizard(root, open_browser=not ns.no_browser)


def cmd_build(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    return build_stack(root, no_cache=ns.no_cache)


def cmd_pull(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    _hint_guided_install(root)
    return pull_stack(root)


def cmd_upgrade(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    _hint_guided_install(root)
    if _candidate_repo_root() is None:
        get_bundle_root(force_download=True)
        print(f"Bundle refreshed under {bundle_data_dir()}", file=sys.stderr)
    rc = pull_stack(root)
    if rc != 0:
        return rc
    return _run(["docker", "compose", "up", "-d", *(ns.docker_compose_args or [])], root)


def cmd_up(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    _hint_guided_install(root)
    extra = ns.docker_compose_args or []

    if not uses_local_build(root):
        missing = missing_registry_images(root)
        if missing or ns.pull:
            if missing:
                print(
                    f"Pulling registry images ({len(missing)} missing locally)...",
                    file=sys.stderr,
                )
            rc = pull_stack(root)
            if rc != 0:
                return rc
    elif should_build_stack(root, force=ns.build):
        if ns.build:
            print(
                "Rebuilding all local stack images (ML runtimes first, then backend/workers/web)...",
                file=sys.stderr,
            )
        else:
            missing = missing_runtime_images(root)
            print(
                f"Some local images are missing ({', '.join(missing)}).",
                file=sys.stderr,
            )
            print(
                "Build order: ultralytics + mmyolo runtimes (if needed), then backend, "
                "worker-gpu, worker-general, web, sam_service. "
                "Let the first step finish — do not interrupt.",
                file=sys.stderr,
            )
        rc = build_stack(root, no_cache=ns.build)
        if rc != 0:
            return rc

    cmd = ["docker", "compose", "up", "-d"]
    # Images already built in order; avoid compose --build (wrong order for ML runtimes).
    cmd.extend(extra)
    return _run(cmd, root)


def cmd_down(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    extra = ns.docker_compose_args or []
    return _run(["docker", "compose", "down", *extra], root)


def cmd_status(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    extra = ns.docker_compose_args or []
    return _run(["docker", "compose", "ps", *extra], root)


def cmd_restart(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    extra = ns.docker_compose_args or []
    return _run(["docker", "compose", "restart", *extra], root)


def cmd_remove_images(ns: argparse.Namespace) -> int:
    """
    Remove Docker images used by this compose stack without touching data volumes.
    Equivalent to: docker compose down --rmi all
    """
    root = get_bundle_root(force_download=ns.refresh)
    extra = ns.docker_compose_args or []
    cmd = ["docker", "compose", "down", "--rmi", "all", *extra]
    rc = _run(cmd, root)

    # Compose/BuildKit can leave tagged images behind (or other containers may still
    # reference them), which can make subsequent builds fail with:
    #   "failed to solve: image ... already exists"
    # Force-remove the common local tags (ignore failures).
    for tag in (
        "lai-backend:local",
        "lai-celery:local",
        "lai-ultralytics:local",
        "lai-mmyolo:local",
        "lai-frontend:local",
    ):
        try:
            _run(["docker", "image", "rm", "-f", tag], root)
        except Exception:
            pass

    return rc


def cmd_compose(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    args = ns.docker_compose_args or []
    if not args:
        print("Usage: lai compose -- <docker compose args>", file=sys.stderr)
        return 2
    return _run(["docker", "compose", *args], root)


def cmd_download_models(ns: argparse.Namespace) -> int:
    """Pre-download foundation weights into the host volume (YOLO ONNX via worker-gpu)."""
    root = get_bundle_root(force_download=ns.refresh)
    _hint_guided_install(root)
    env_yolo = ns.yolo or "minimal"
    env_depth = ns.depth or "minimal"
    env_mmyolo = ns.mmyolo or "minimal"
    print(
        f"Downloading models  yolo={env_yolo!r}  depth={env_depth!r}  mmyolo={env_mmyolo!r}",
        file=sys.stderr,
    )
    rc = _run(
        [
            "docker", "compose", "exec",
            "-e", f"LAI_PRETRAINED_MODELS={env_yolo}",
            "worker-gpu",
            "python", "scripts/download_ultralytics_models.py",
        ],
        root,
    )
    if rc != 0:
        return rc
    rc = _run(
        [
            "docker", "compose", "exec",
            "-e", f"LAI_DEPTH_MODELS={env_depth}",
            "backend",
            "python", "scripts/download_depth_anything_models.py",
        ],
        root,
    )
    if rc != 0:
        return rc
    return _run(
        [
            "docker", "compose", "exec",
            "-e", f"LAI_PRETRAINED_MODELS={env_yolo}",
            "-e", f"LAI_DEPTH_MODELS={env_depth}",
            "-e", f"LAI_MMYOLO_MODELS={env_mmyolo}",
            "worker-gpu",
            "sh",
            "-lc",
            (
                "if [ -f scripts/download_mmyolo_models.py ]; then "
                "python scripts/download_mmyolo_models.py; "
                "elif [ -f backend/scripts/download_mmyolo_models.py ]; then "
                "python backend/scripts/download_mmyolo_models.py; "
                "else "
                "echo 'download_mmyolo_models.py not found in container' >&2; "
                "exit 1; "
                "fi"
            ),
        ],
        root,
    )


def cmd_sync(ns: argparse.Namespace) -> int:
    """Re-download bundle (PyPI / cache layout only)."""
    if _candidate_repo_root() is not None:
        print("Using local git checkout; nothing to sync. git pull the repo instead.", file=sys.stderr)
        return 0
    get_bundle_root(force_download=True)
    print(f"Bundle refreshed under {bundle_data_dir()}")
    return 0


def cmd_uninstall(ns: argparse.Namespace) -> int:
    root = get_bundle_root(force_download=ns.refresh)
    return run_uninstall(
        root,
        assume_yes=ns.yes,
        keep_env=ns.keep_env,
        skip_compose_down=ns.no_down,
        no_rmi=ns.no_rmi,
        include_pip_bundle=ns.include_pip_bundle,
    )


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    p = argparse.ArgumentParser(
        prog="lai",
        description="LAI stack via Docker Compose (needs Docker + Compose 2.24+). "
        "pip install only adds this CLI — run `lai install` once for guided setup, then `lai up`.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Typical first run (pull-only):\n  pip install laivision\n  lai install-gui\n  lai pull && lai up\n\nDevelopers (git clone):\n  pip install -e .\n  lai install-gui\n  lai up --build\n\nRemove data:  lai uninstall  (type DELETE to confirm)",
    )
    p.add_argument("--version", action="version", version=f"lai {lai.__version__}")

    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("doctor", help="Show version, bundle path, and Docker info")
    sp.set_defaults(func=cmd_doctor)

    sp = sub.add_parser("bundle-path", help="Print directory containing docker-compose.yml")
    sp.add_argument(
        "--refresh",
        action="store_true",
        help="Force re-download when using a cached PyPI bundle",
    )
    sp.set_defaults(func=cmd_bundle_path)

    sp = sub.add_parser("install", help="Run guided install in the terminal (writes .env, checks Docker)")
    sp.add_argument("-y", "--yes", action="store_true", help="Non-interactive (see scripts/install.sh)")
    bind_group = sp.add_mutually_exclusive_group()
    bind_group.add_argument(
        "--bind-code",
        action="store_true",
        help="Mount host backend over /app (default; sets COMPOSE_FILE with docker-compose.code-mount.yml)",
    )
    bind_group.add_argument(
        "--no-bind-code",
        action="store_true",
        help="Use only the backend image for /app (no host bind; pre-built images)",
    )
    sp.add_argument(
        "--refresh",
        action="store_true",
        help="Re-download app bundle before installing (cached PyPI layout only)",
    )
    sp.set_defaults(func=cmd_install)

    sp = sub.add_parser(
        "install-gui",
        help="Browser wizard on 127.0.0.1: data folder, web port, pretrained Docker models, SAM 3; then lai up",
    )
    sp.add_argument(
        "--no-browser",
        action="store_true",
        help="Only print the URL (for remote/headless)",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_install_gui)

    sp = sub.add_parser("build", help="Build Docker images in dependency order (ML runtimes → celery → backend)")
    sp.add_argument(
        "--no-cache",
        action="store_true",
        help="Pass --no-cache to docker compose build",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_build)

    sp = sub.add_parser("pull", help="Pull pre-built images from the registry (.env LAI_*_IMAGE tags)")
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_pull)

    sp = sub.add_parser(
        "upgrade",
        help="Refresh bundle (PyPI installs), pull images, and restart stack",
    )
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose up",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_upgrade)

    sp = sub.add_parser(
        "up",
        help="Start stack (pull registry images or build missing local images)",
    )
    sp.add_argument(
        "--build",
        action="store_true",
        help="Rebuild all local images in dependency order before starting",
    )
    sp.add_argument(
        "--pull",
        action="store_true",
        help="Pull registry images before starting (even if already present)",
    )
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose",
    )
    sp.add_argument(
        "--refresh",
        action="store_true",
        help="Re-download bundle first (cached PyPI layout only)",
    )
    sp.set_defaults(func=cmd_up)

    sp = sub.add_parser("down", help="docker compose down")
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_down)

    sp = sub.add_parser("status", help="docker compose ps (show running stack services)")
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose ps",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("restart", help="docker compose restart (restart all containers)")
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose (e.g., service names to restart specific services)",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_restart)

    sp = sub.add_parser(
        "remove",
        help="Remove stack Docker images only (keeps data/volumes).",
    )
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose down --rmi all",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_remove_images)

    sp = sub.add_parser(
        "delete",
        help="Alias of 'remove' (remove stack Docker images, keep data).",
    )
    sp.add_argument(
        "docker_compose_args",
        nargs="*",
        help="Extra args passed to docker compose down --rmi all",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_remove_images)

    sp = sub.add_parser("compose", help="Run docker compose with arbitrary arguments")
    sp.add_argument(
        "docker_compose_args",
        nargs=argparse.REMAINDER,
        help="Arguments after -- are passed to docker compose",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_compose)

    sp = sub.add_parser(
        "sync",
        help="Re-download application files (only for pip installs without a local repo)",
    )
    sp.set_defaults(func=cmd_sync)

    sp = sub.add_parser(
        "download-models",
        help="Pre-download YOLO + Depth-Anything + MMYOLO weights into the host models volume",
    )
    sp.add_argument(
        "--yolo",
        default=None,
        help="LAI_PRETRAINED_MODELS spec: all | minimal | none | comma list (default: minimal)",
    )
    sp.add_argument(
        "--depth",
        default=None,
        help="LAI_DEPTH_MODELS spec: all | minimal | none | comma list (default: minimal)",
    )
    sp.add_argument(
        "--mmyolo",
        default=None,
        help="LAI_MMYOLO_MODELS spec: all | minimal | none | comma list (default: minimal)",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_download_models)

    sp = sub.add_parser(
        "uninstall",
        help="Stop stack, docker compose down --rmi all, delete data dir + .env (type DELETE to confirm)",
    )
    sp.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Skip confirmation (for scripts)",
    )
    sp.add_argument(
        "--keep-env",
        action="store_true",
        help="Keep .env (only remove data directory)",
    )
    sp.add_argument(
        "--no-down",
        action="store_true",
        help="Do not run docker compose down",
    )
    sp.add_argument(
        "--no-rmi",
        action="store_true",
        help="Run docker compose down without removing images (--rmi all is the default)",
    )
    sp.add_argument(
        "--include-pip-bundle",
        action="store_true",
        help="Also remove ~/.local/share/lai/app (PyPI-downloaded copy of the repo)",
    )
    sp.add_argument("--refresh", action="store_true")
    sp.set_defaults(func=cmd_uninstall)

    ns = p.parse_args(argv)
    if ns.cmd == "compose" and ns.docker_compose_args and ns.docker_compose_args[0] == "--":
        ns.docker_compose_args = ns.docker_compose_args[1:]
    return int(ns.func(ns))


if __name__ == "__main__":
    raise SystemExit(main())
