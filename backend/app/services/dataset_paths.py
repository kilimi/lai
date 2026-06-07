"""Filesystem paths and URL rewriting for dataset storage under ``projects/``."""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app import models

logger = logging.getLogger(__name__)


def primary_projects_disk_root() -> Path:
    """Writable ``projects`` directory used for uploads (Docker: ``/app/projects``)."""
    candidates: List[Path] = []
    env = os.environ.get("LAI_PROJECTS_ROOT", "").strip()
    if env:
        candidates.append(Path(env))
    backend_root = Path(__file__).resolve().parents[2]  # .../backend
    repo_root = backend_root.parent
    candidates.extend(
        [
            Path("/app/projects"),
            Path("projects"),
            backend_root / "projects",
            repo_root / "projects",
            repo_root / ".lai-data" / "projects",
        ]
    )
    seen = set()
    for raw in candidates:
        p = raw.resolve() if raw.exists() else raw
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        try:
            if p.is_dir():
                return p.resolve()
        except OSError:
            continue
    base = Path("projects")
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def rewrite_dataset_storage_url_segment(
    value: Optional[str],
    *,
    old_project_id: int,
    new_project_id: int,
    dataset_id: int,
) -> Optional[str]:
    """Rewrite paths pointing at ``projects/<old_pid>/<dataset_id>/`` to the new project id."""
    if value is None or value == "":
        return value
    pairs = (
        (
            f"/static/projects/{old_project_id}/{dataset_id}/",
            f"/static/projects/{new_project_id}/{dataset_id}/",
        ),
        (
            f"/projects/{old_project_id}/{dataset_id}/",
            f"/projects/{new_project_id}/{dataset_id}/",
        ),
        (
            f"projects/{old_project_id}/{dataset_id}/",
            f"projects/{new_project_id}/{dataset_id}/",
        ),
        (
            f"/static/projects\\{old_project_id}\\{dataset_id}\\",
            f"/static/projects/{new_project_id}/{dataset_id}/",
        ),
    )
    out = value
    for old_seg, new_seg in pairs:
        out = out.replace(old_seg, new_seg)
    return out


def apply_storage_url_rewrite_for_project_move(
    db: Session,
    dataset: models.Dataset,
    *,
    dataset_id: int,
    old_project_id: int,
    new_project_id: int,
) -> None:
    """Update dataset + image rows so ``/static/projects/<old>/`` paths match the new project folder."""
    for field_name in ("logo_url", "thumbnailUrl", "url"):
        val = getattr(dataset, field_name, None)
        if val:
            setattr(
                dataset,
                field_name,
                rewrite_dataset_storage_url_segment(
                    val,
                    old_project_id=old_project_id,
                    new_project_id=new_project_id,
                    dataset_id=dataset_id,
                ),
            )
    for im in db.query(models.Image).filter(models.Image.dataset_id == dataset_id).all():
        if im.url:
            im.url = rewrite_dataset_storage_url_segment(
                im.url,
                old_project_id=old_project_id,
                new_project_id=new_project_id,
                dataset_id=dataset_id,
            )
        if im.thumbnail_url:
            im.thumbnail_url = rewrite_dataset_storage_url_segment(
                im.thumbnail_url,
                old_project_id=old_project_id,
                new_project_id=new_project_id,
                dataset_id=dataset_id,
            )


def filesystem_relocate_dataset_tree(
    old_project_id: int,
    new_project_id: int,
    dataset_id: int,
) -> Tuple[bool, Optional[str]]:
    """
    Move ``projects/<old>/<dataset_id>/`` -> ``projects/<new>/<dataset_id>/``.

    Returns ``(did_relocate_tree, error_message)``. ``did_relocate`` is False if the
    source tree did not exist.
    """
    root = primary_projects_disk_root()
    src = root / str(old_project_id) / str(dataset_id)
    dst_parent = root / str(new_project_id)
    dst = dst_parent / str(dataset_id)

    try:
        if not src.exists():
            logger.warning(
                "Dataset move: no filesystem tree at %s (dataset_id=%s)",
                src,
                dataset_id,
            )
            return False, None

        dst_parent.mkdir(parents=True, exist_ok=True)

        if dst.exists():
            try:
                if dst.samefile(src):
                    return False, None
            except OSError:
                pass
            if any(dst.iterdir()):
                return False, (
                    f"Target dataset directory already exists and is not empty: {dst}. "
                    "Rename or remove it before moving this dataset."
                )
            try:
                shutil.rmtree(dst)
            except OSError as exc:
                return False, f"Cannot clear empty target directory {dst}: {exc}"

        shutil.move(str(src), str(dst))
        logger.info("Moved dataset filesystem tree %s -> %s", src, dst)
        return True, None

    except OSError as exc:
        return False, f"Failed to move dataset files from {src} to {dst}: {exc}"
