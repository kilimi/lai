"""
Resolve on-disk paths for dataset images.

Handles:
  - Canonical layout: .../projects/<project>/<dataset>/images/[c<coll>/]<file>
  - URLs with /static/ prefix or query strings
  - DB project_id drifting from filesystem (e.g. dataset moved — files stay under old project folder).
"""
from __future__ import annotations

import os
import logging
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from urllib.parse import urlparse

logger = logging.getLogger(__name__)

ImageLike = object  # ORM Image row with file_name, url, collection_id


def iter_projects_roots() -> List[Path]:
    roots: List[Path] = []
    env = os.environ.get("LAI_PROJECTS_ROOT", "").strip()
    if env:
        roots.append(Path(env))
    backend_root = Path(__file__).resolve().parent.parent  # backend/
    repo_root = backend_root.parent
    roots.extend(
        [
            Path("/app/projects"),
            Path("projects"),
            backend_root / "projects",
            repo_root / "projects",
            repo_root / ".lai-data" / "projects",
        ]
    )
    uniq: List[Path] = []
    seen_str = set()
    for r in roots:
        k = str(r.resolve()) if r.exists() else str(r)
        if k not in seen_str:
            seen_str.add(k)
            uniq.append(r)
    return uniq


def _normalize_url_derived_relative_path(raw: str) -> str:
    parsed = urlparse(raw.strip())
    if parsed.scheme and parsed.scheme.lower() not in ("http", "https"):
        rp = parsed.path.lstrip("/")
        if rp:
            return f"{parsed.scheme}/{rp}"
        return parsed.scheme
    url_path = (parsed.path or raw).strip()
    if url_path.startswith("/"):
        url_path = url_path.lstrip("/")
    if url_path.startswith("static/"):
        url_path = url_path[len("static/") :]
    return url_path


def iter_candidate_relative_paths_under_images(
    file_name: str,
    *,
    collection_id: Optional[int] = None,
) -> Tuple[Tuple[str, ...], ...]:
    """
    Path segments AFTER .../<dataset>/images/ for filesystem lookup.
    """
    fn = (file_name or "").strip()
    basename = Path(fn).name if fn else ""
    out: List[Tuple[str, ...]] = []

    coll_prefix: Tuple[str, ...] = ()
    if collection_id is not None:
        coll_prefix = (f"c{int(collection_id)}",)

    variants: List[str] = []
    if fn:
        variants.append(fn)
    if basename and basename != fn:
        variants.append(basename)
    seen = set()
    for v in variants:
        if not v or v in seen:
            continue
        seen.add(v)
        out.append((v,))
        if coll_prefix:
            out.append((*coll_prefix, v))

    if coll_prefix and basename:
        t = (*coll_prefix, basename)
        if t not in out:
            out.append(t)
    return tuple(out)


def _exists_file(p: Path) -> bool:
    try:
        return p.is_file()
    except OSError:
        return False


def find_dataset_image_scan_projects(
    dataset_id: int,
    suffix_parts: Sequence[str],
) -> Optional[Path]:
    """Scan ``projects/*/<dataset_id>/images/<suffix_parts>`` on every known projects root."""
    ds = str(int(dataset_id))
    tail = Path(*suffix_parts)
    for root in iter_projects_roots():
        try:
            if not root.exists() or not root.is_dir():
                continue
        except OSError:
            continue
        try:
            for proj_dir in root.iterdir():
                try:
                    if not proj_dir.is_dir():
                        continue
                    candidate = proj_dir / ds / "images" / tail
                    if _exists_file(candidate):
                        return candidate.resolve()
                except OSError:
                    continue
        except OSError as e:
            logger.debug("Scan projects root %s: %s", root, e)
            continue
    return None


def resolve_dataset_image_path(
    *,
    dataset_id: int,
    project_id: Optional[int],
    file_name: str,
    img_url: str = "",
    collection_id: Optional[int] = None,
    effective_collection_id: Optional[int] = None,
) -> Optional[Path]:
    ds = str(int(dataset_id))
    pid_opt = int(project_id) if project_id is not None else None

    coll_eff = effective_collection_id
    if coll_eff is None:
        coll_eff = collection_id

    fn = (file_name or "").strip()
    if not fn:
        return None
    basename = Path(fn).name

    candidates: List[Path] = []

    rel_under_images_list = iter_candidate_relative_paths_under_images(
        fn, collection_id=coll_eff
    )

    if pid_opt is not None:
        pid = str(pid_opt)
        for tail_parts in rel_under_images_list:
            tail_path = Path(*tail_parts)
            canonical = Path("projects") / pid / ds / "images" / tail_path
            candidates.append(canonical)
            candidates.append(Path("/app/projects") / pid / ds / "images" / tail_path)

    candidates.extend(
        [
            Path("data") / "images" / ds / fn,
            Path("/app/data") / "images" / ds / fn,
        ]
    )
    if basename != fn:
        candidates.extend(
            [
                Path("data") / "images" / ds / basename,
                Path("/app/data") / "images" / ds / basename,
            ]
        )

    if img_url.strip():
        url_path = _normalize_url_derived_relative_path(img_url.strip())
        if url_path:
            p = Path(url_path)
            candidates.append(p)
            candidates.append(Path("/app") / p)
            if not str(p).startswith("projects"):
                candidates.append(Path("projects") / p)
                candidates.append(Path("/app/projects") / p)


    backend_root = Path(__file__).resolve().parent.parent
    repo_root = backend_root.parent

    expanded: List[Path] = []
    seen = set()
    for cand in candidates:
        for variant in (
            cand,
            repo_root / cand,
            backend_root / cand,
        ):
            ks = str(variant)
            if ks not in seen:
                seen.add(ks)
                expanded.append(variant)

    for cand in expanded:
        try:
            if _exists_file(cand):
                return cand.resolve()
        except OSError:
            continue


    # Basename recursive search under canonical dataset folder (cheap when exists).
    if pid_opt is not None:
        pid = str(pid_opt)
        for root in iter_projects_roots():
            try:
                canon = root / pid / ds / "images"
                if not canon.exists():
                    continue
                for match in sorted(canon.rglob(basename)):
                    if match.is_file():
                        return match.resolve()
            except OSError:
                continue

    for tail_parts in rel_under_images_list:
        hit = find_dataset_image_scan_projects(dataset_id, tail_parts)
        if hit:
            return hit

    if basename:
        hit = find_dataset_image_scan_projects(dataset_id, (basename,))
        if hit:
            return hit

    return None


def resolve_dataset_image_path_from_models(
    img: ImageLike,
    *,
    dataset_id: int,
    project_id: Optional[int],
    collection_id: Optional[int] = None,
) -> Optional[Path]:
    fn = getattr(img, "file_name", None)
    ur = getattr(img, "url", None) or ""
    icoll = getattr(img, "collection_id", None)
    eff_coll = collection_id if collection_id is not None else (
        int(icoll) if icoll is not None else None
    )
    return resolve_dataset_image_path(
        dataset_id=dataset_id,
        project_id=project_id,
        file_name=(fn or "") if isinstance(fn, str) else str(fn),
        img_url=str(ur or ""),
        collection_id=collection_id,
        effective_collection_id=eff_coll,
    )
