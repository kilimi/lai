"""Remove LAI user data, .env, and (by default) Docker images used by this compose project."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path


def parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        k, _, v = s.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


from lai.paths import resolve_env_file


def resolve_data_dir(bundle_root: Path) -> Path | None:
    env_path = resolve_env_file(bundle_root)
    vals = parse_dotenv(env_path)
    raw = vals.get("LAI_DATA_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    default = (bundle_root / ".lai-data").resolve()
    if default.is_dir():
        return default
    return None


def _is_safe_to_delete(target: Path, bundle_root: Path) -> tuple[bool, str]:
    try:
        r = target.resolve()
    except OSError as e:
        return False, str(e)
    if not r.exists():
        return True, ""

    home = Path.home().resolve()
    if r == Path("/"):
        return False, "refusing to delete /"
    if r == home:
        return False, "refusing to delete your entire home directory"
    br = bundle_root.resolve()
    if r == br:
        return False, "refusing to delete the application directory (source/bundle root)"
    try:
        rel = r.relative_to(br)
        if rel.parts and rel.parts[0] != ".lai-data":
            return False, "refusing to delete inside the app folder (only …/.lai-data/ is allowed there)"
    except ValueError:
        pass  # outside bundle root — OK if other checks pass

    forbidden_roots = (
        Path("/usr"),
        Path("/etc"),
        Path("/bin"),
        Path("/boot"),
        Path("/sbin"),
        Path("/lib"),
        Path("/opt"),
        Path("/var"),
    )
    for fr in forbidden_roots:
        try:
            if r == fr or fr in r.parents:
                return False, f"refusing to delete path under {fr}"
        except (OSError, ValueError):
            pass

    # Allow .lai-data inside repo or ~/lai-data etc.
    return True, ""


def _rmtree_chmod_retry(path: Path) -> bool:
    """Try to remove a tree; chmod writable on failure (helps read-only bits, not root-owned files)."""

    def _chmod_best_effort(p: str | os.PathLike[str]) -> None:
        try:
            os.chmod(p, stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)
        except OSError:
            pass

    def _retry_unlink_or_rmdir_only(func, p: str) -> None:
        # Python 3.12+ passes os.open / os.scandir / os.lstat / os.close here too — do not call func(p).
        if func not in (os.unlink, os.rmdir, os.remove):
            return
        try:
            func(p)
        except OSError:
            pass

    def _onexc(func, p: str, _exc: BaseException) -> None:
        _chmod_best_effort(p)
        _retry_unlink_or_rmdir_only(func, p)

    def _onerror(func, p: str, _exc_info) -> None:
        _chmod_best_effort(p)
        _retry_unlink_or_rmdir_only(func, p)

    try:
        # onexc: Python 3.12+; avoids deprecated onerror and matches fd-based rmtree callbacks.
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=_onexc)
        else:
            shutil.rmtree(path, onerror=_onerror)
        return not path.exists()
    except OSError:
        return False


def _remove_data_dir_via_docker(data_dir: Path) -> bool:
    """
    Delete contents using a one-off container as root.

    Bind-mounted project data is often owned by root (uid 0) from containers; the host user
    cannot shutil.rmtree() those paths. A short-lived container can delete them.
    """
    if not shutil.which("docker"):
        return False
    host = str(data_dir.resolve())
    if not os.path.isdir(host):
        return False
    try:
        r = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{host}:/d",
                "alpine:3.19",
                "find",
                "/d",
                "-mindepth",
                "1",
                "-delete",
            ],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if r.returncode != 0:
        return False
    if not data_dir.exists():
        return True
    try:
        data_dir.rmdir()
    except OSError:
        if not _rmtree_chmod_retry(data_dir):
            return not data_dir.exists()
    return not data_dir.exists()


def _remove_data_directory(data_dir: Path) -> tuple[bool, str | None]:
    """
    Remove user data directory. Returns (ok, err_detail).
    err_detail is set on failure for printing (multiline ok).
    """
    if _rmtree_chmod_retry(data_dir):
        return True, None
    print(
        "  Note: could not delete as your user (often root-owned files from Docker). "
        "Trying a one-off Alpine container to clear the data folder…",
        flush=True,
    )
    if _remove_data_dir_via_docker(data_dir):
        return True, None
    return False, (
        "Permission denied while deleting data (often root-owned files created by Docker).\n"
        f"  Tried: delete as your user, then a one-off Alpine container on:\n"
        f"  {data_dir.resolve()}\n"
        "  Fix manually, then remove the folder or run uninstall again:\n"
        f"    sudo rm -rf {data_dir.resolve()}\n"
        "  or:\n"
        f"    sudo chown -R \"$(id -u)\":\"$(id -g)\" {data_dir.resolve()}\n"
        "    lai uninstall"
    )


def run_uninstall(
    bundle_root: Path,
    *,
    assume_yes: bool = False,
    keep_env: bool = False,
    skip_compose_down: bool = False,
    no_rmi: bool = False,
    include_pip_bundle: bool = False,
) -> int:
    data_dir = resolve_data_dir(bundle_root)
    env_file = resolve_env_file(bundle_root)

    print("LAI uninstall — stops the stack, removes data + .env, and by default removes compose images.")
    print("(Does not remove application source code or SAM 3 weights on disk — see SAM3_MODELS_HOST_PATH.)")
    print()
    if data_dir is not None:
        ok, reason = _is_safe_to_delete(data_dir, bundle_root)
        if not ok:
            print(f"Error: {reason}", file=sys.stderr)
            return 1
        print(f"  Data directory to delete: {data_dir}")
    else:
        print("  No LAI_DATA_DIR in .env and no repo .lai-data/ — no database/project tree to remove.")

    if env_file.is_file() and not keep_env:
        print(f"  .env to delete: {env_file}")
    elif keep_env:
        print("  .env: kept (--keep-env)")

    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    pip_base = Path(xdg) / "lai" / "app" if xdg else Path.home() / ".local" / "share" / "lai" / "app"
    pip_ok = True
    if include_pip_bundle and pip_base.is_dir():
        ok, reason = _is_safe_to_delete(pip_base, bundle_root)
        pip_ok = ok
        if ok:
            print(f"  PyPI download cache to delete: {pip_base}")
        else:
            print(f"  Skipping pip bundle: {reason}", file=sys.stderr)

    will_rm_data = data_dir is not None and data_dir.exists()
    will_rm_env = env_file.is_file() and not keep_env
    will_rm_pip = include_pip_bundle and pip_base.is_dir() and pip_ok
    docker_ok = bool(shutil.which("docker"))
    will_compose_down = docker_ok and not skip_compose_down
    will_rmi = will_compose_down and not no_rmi
    if will_rmi:
        print("  Docker: docker compose down --rmi all (images declared in this compose file)")
    elif will_compose_down and no_rmi:
        print("  Docker: docker compose down only (--no-rmi)")
    elif skip_compose_down:
        print("  Docker: skipped (--no-down)")

    print()
    if not will_rm_data and not will_rm_env and not will_rm_pip and not will_compose_down:
        print("Nothing to do.")
        return 0

    if not assume_yes:
        confirm = input('Type DELETE (in capitals) to continue, or anything else to abort: ').strip()
        if confirm != "DELETE":
            print("Aborted.")
            return 1

    if will_compose_down:
        cmd = ["docker", "compose", "down"]
        if will_rmi:
            cmd.extend(["--rmi", "all"])
        subprocess.run(cmd, cwd=bundle_root, check=False)
        if will_rmi:
            print("Ran: docker compose down --rmi all")
        else:
            print("Ran: docker compose down")

    if will_rm_data:
        ok, err_detail = _remove_data_directory(data_dir)
        if not ok:
            print(f"Error removing data dir:\n{err_detail}", file=sys.stderr)
            return 1
        print(f"Removed {data_dir}")

    if env_file.is_file() and not keep_env:
        try:
            env_file.unlink()
            print(f"Removed {env_file}")
        except OSError as e:
            print(f"Error removing .env: {e}", file=sys.stderr)
            return 1

    if will_rm_pip:
        try:
            shutil.rmtree(pip_base)
            print(f"Removed {pip_base}")
        except OSError as e:
            print(f"Warning: could not remove pip bundle: {e}", file=sys.stderr)

    print()
    print("Done. SAM 3 weights (folder from SAM3_MODELS_HOST_PATH in .env) were not removed.")
    if no_rmi or skip_compose_down:
        print("Tip: to remove images later: docker compose down --rmi all  (from the bundle directory)")
    return 0
