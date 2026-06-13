from __future__ import annotations

import shutil
import tarfile
import tempfile
from pathlib import Path

from lai.constants import DEFAULT_BUNDLE_TARBALL
from lai.http_fetch import fetch_bytes
from lai.paths import bundle_data_dir


def ensure_bundle(*, force: bool = False) -> Path:
    """
    Download and extract the application tree if needed.
    Returns the root directory containing docker-compose.yml.
    """
    dest = bundle_data_dir()
    compose = dest / "docker-compose.yml"
    if compose.is_file() and not force:
        return dest

    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    url = DEFAULT_BUNDLE_TARBALL
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        tpath = Path(tmp.name)
    try:
        tpath.write_bytes(fetch_bytes(url, timeout=120))
        _extract_tarball_strip_root(tpath, dest)
    finally:
        tpath.unlink(missing_ok=True)

    if not (dest / "docker-compose.yml").is_file():
        raise RuntimeError(
            f"Bundle from {url} did not contain docker-compose.yml at expected layout. "
            "Set LAI_BUNDLE_URL to a tarball of the repository root."
        )
    return dest


def _extract_tarball_strip_root(archive: Path, dest: Path) -> None:
    """GitHub/codeload tarballs contain a single top-level directory; flatten to dest."""
    tmp = Path(tempfile.mkdtemp(prefix="lai-extract-"))
    try:
        with tarfile.open(archive, "r:gz") as tf:
            tf.extractall(tmp)
        children = [p for p in tmp.iterdir() if not p.name.startswith(".")]
        if len(children) != 1 or not children[0].is_dir():
            raise RuntimeError(
                f"Expected one top-level directory in tarball, got {[p.name for p in children]}"
            )
        shutil.move(str(children[0]), str(dest))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
