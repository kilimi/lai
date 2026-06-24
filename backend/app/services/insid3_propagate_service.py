"""Run INSID3 batch propagation and store per-image polygons in task metadata."""
from __future__ import annotations

import base64
import io
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
from PIL import Image
from sqlalchemy import or_
from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal
from app import models
from app.services.media_bytes import fetch_image_b64, fetch_image_bytes, resolve_media_url

logger = logging.getLogger(__name__)

SAM_SERVICE_URL = os.environ.get("SAM_SERVICE_URL", "http://sam_service:8081")


def _query_layer_images(
    db,
    dataset_id: int,
    collection_id: Optional[int],
) -> List[models.Image]:
    """Match image_collections API: default layer includes unassigned (NULL) rows."""
    q = db.query(models.Image).filter(models.Image.dataset_id == dataset_id)
    if collection_id is not None:
        coll = (
            db.query(models.ImageCollection)
            .filter(
                models.ImageCollection.id == int(collection_id),
                models.ImageCollection.dataset_id == dataset_id,
            )
            .first()
        )
        if coll and coll.is_default:
            q = q.filter(
                or_(
                    models.Image.collection_id == int(collection_id),
                    models.Image.collection_id.is_(None),
                )
            )
        else:
            q = q.filter(models.Image.collection_id == int(collection_id))
    return q.order_by(models.Image.id.asc()).all()


def _image_name_keys(file_name: str | None) -> set[str]:
    raw = (file_name or "").strip().lower()
    if not raw:
        return set()
    base = os.path.basename(raw).lower()
    return {raw, base} if base != raw else {raw}


def _resolve_search_images(
    db,
    dataset_id: int,
    collection_id: Optional[int],
    target_image_names: Optional[List[str]],
) -> List[models.Image]:
    """Resolve images to search; UI file-name list (if provided) matches SAM layer view."""
    pool = _query_layer_images(db, dataset_id, collection_id)
    if not target_image_names:
        return pool

    allowed: set[str] = set()
    for name in target_image_names:
        allowed.update(_image_name_keys(name))

    by_key: Dict[str, models.Image] = {}
    for img in pool:
        for key in _image_name_keys(img.file_name):
            by_key.setdefault(key, img)

    ordered: List[models.Image] = []
    seen_ids: set[int] = set()
    for name in target_image_names:
        matched: models.Image | None = None
        for key in _image_name_keys(name):
            candidate = by_key.get(key)
            if candidate is not None:
                matched = candidate
                break
        if matched is not None and matched.id not in seen_ids:
            seen_ids.add(matched.id)
            ordered.append(matched)
    return ordered


def _apply_reference_exclusion(
    images: List[models.Image],
    references: List[Dict[str, Any]],
    exclude_refs: bool,
) -> tuple[List[models.Image], int]:
    if not exclude_refs:
        return images, 0
    ref_keys: set[str] = set()
    for ref in references:
        ref_keys.update(_image_name_keys(ref.get("imageName")))
    if not ref_keys:
        return images, 0
    kept: List[models.Image] = []
    excluded = 0
    for img in images:
        if ref_keys.intersection(_image_name_keys(img.file_name)):
            excluded += 1
        else:
            kept.append(img)
    return kept, excluded


def _enrich_reference(ref: Dict[str, Any]) -> Dict[str, Any]:
    item = dict(ref)
    if not item.get("imageB64"):
        url = item.get("imageUrl")
        b64 = fetch_image_b64(url)
        if b64:
            item["imageB64"] = b64
            item.pop("imageUrl", None)
    return item


def _prepare_references(references: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [_enrich_reference(r) for r in references]


def _decode_image_size(raw_b64: str) -> Tuple[int, int]:
    try:
        data = base64.b64decode(raw_b64)
        with Image.open(io.BytesIO(data)) as pil:
            return pil.size
    except Exception:
        return 0, 0


def _load_image_b64_and_size(url: str | None) -> Tuple[Optional[str], int, int]:
    raw = fetch_image_bytes(url)
    if not raw:
        return None, 0, 0
    try:
        with Image.open(io.BytesIO(raw)) as pil:
            w, h = pil.size
        return base64.b64encode(raw).decode("ascii"), w, h
    except Exception as exc:
        logger.warning("Failed to decode image %s: %s", url, exc)
        return None, 0, 0


def _self_test_references(references: List[Dict[str, Any]], md: Dict[str, Any]) -> Dict[str, Any]:
    """Run INSID3 on the first reference image as its own target (sanity check)."""
    if not references:
        return {"ok": False, "reason": "No references provided."}
    refs = _prepare_references(references)
    first = refs[0]
    b64 = first.get("imageB64")
    if not b64:
        return {
            "ok": False,
            "reason": (
                "Could not load reference image bytes. "
                "Re-pick references on the image (with canvas snapshot) or check dataset file paths."
            ),
        }
    w = int(first.get("width") or 0)
    h = int(first.get("height") or 0)
    if w <= 0 or h <= 0:
        w, h = _decode_image_size(b64)
    try:
        out = _call_insid3(refs, b64, w, h, md)
    except Exception as exc:
        return {"ok": False, "reason": f"INSID3 self-test failed: {exc}"}
    polys = out.get("polygons") or []
    diag = out.get("diagnostics") or {}
    if polys:
        return {
            "ok": True,
            "reason": f"Self-test passed on {first.get('imageName') or 'reference'} ({len(polys)} region(s)).",
            "diagnostics": diag,
        }
    return {
        "ok": False,
        "reason": diag.get("reason")
        or "INSID3 found nothing even on a reference image — mask/image alignment or model setup is wrong.",
        "diagnostics": diag,
    }


def _call_insid3(references: List[Dict[str, Any]], target_b64: str, w: int, h: int, md: Dict[str, Any]) -> dict:
    refs = references if references and references[0].get("imageB64") else _prepare_references(references)
    if w <= 0 or h <= 0:
        w, h = _decode_image_size(target_b64)
    payload = {
        "references": refs,
        "targetImageB64": target_b64,
        "targetWidth": w,
        "targetHeight": h,
        "image_size": int(md.get("image_size") or 768),
        "model_size": md.get("model_size") or "base",
        "min_area": float(md.get("min_area") or 0),
    }
    logger.info(
        "[INSID3] worker -> sam_service POST /segment/insid3 refs=%s target=%sx%s",
        len(refs),
        w,
        h,
    )
    with httpx.Client(timeout=180.0) as client:
        resp = client.post(f"{SAM_SERVICE_URL}/segment/insid3", json=payload)
        resp.raise_for_status()
        out = resp.json()
        logger.info(
            "[INSID3] sam_service polygons=%s",
            len(out.get("polygons") or []),
        )
        return out


def _reference_rows_from_payload(references: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for i, ref in enumerate(references):
        polygon = ref.get("polygon") or (ref.get("mask") or {}).get("polygon") or []
        rows.append(
            {
                "index": i,
                "imageName": ref.get("imageName") or ref.get("annotationId") or f"ref[{i}]",
                "width": int(ref.get("width") or ref.get("imageWidth") or 0),
                "height": int(ref.get("height") or ref.get("imageHeight") or 0),
                "polygonVertices": len(polygon),
            }
        )
    return rows


def _aggregate_batch_diagnostics(
    results: Dict[str, Any],
    md: Dict[str, Any],
) -> Dict[str, Any]:
    """Summarize per-image INSID3 diagnostics for task metadata / GUI."""
    outcomes: Dict[str, int] = {}
    samples: List[Dict[str, Any]] = []
    settings: Dict[str, Any] | None = None
    references: List[Dict[str, Any]] | None = None

    for file_name, entry in results.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("error"):
            key = "error"
            outcomes[key] = outcomes.get(key, 0) + 1
            if len(samples) < 12:
                samples.append(
                    {
                        "image": file_name,
                        "outcome": key,
                        "reason": str(entry.get("error")),
                    }
                )
            continue

        diag = entry.get("diagnostics") or {}
        outcome = str(diag.get("outcome") or ("match" if entry.get("polygons") else "no_match"))
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        if settings is None:
            settings = diag.get("settings")
        if references is None:
            references = diag.get("references")
        if outcome != "match" and len(samples) < 12:
            inference = diag.get("inference") or {}
            post = diag.get("postprocess") or {}
            samples.append(
                {
                    "image": file_name,
                    "outcome": outcome,
                    "reason": diag.get("reason"),
                    "positivePixels": inference.get("positivePixels"),
                    "skippedByMinArea": post.get("skippedByMinArea"),
                }
            )

    ref_warnings = [
        r for r in (references or md.get("reference_diagnostics") or []) if r.get("warning")
    ]
    hints: List[str] = []
    total = sum(outcomes.values())
    empty_model = outcomes.get("empty_model_mask", 0)
    filtered = outcomes.get("filtered_by_min_area", 0)
    empty_ref = outcomes.get("empty_reference_mask", 0)
    if ref_warnings:
        hints.append(
            "One or more reference masks are empty after rasterization — re-pick references on the canvas."
        )
    self_test = md.get("self_test") or {}
    if self_test and not self_test.get("ok"):
        hints.insert(
            0,
            str(
                self_test.get("reason")
                or "Reference self-test failed — fix references before searching the layer."
            ),
        )
    if total > 0 and empty_model == total:
        hints.append(
            "INSID3 returned an empty mask on every searched image. References may not match objects in this layer, "
            "or examples are too visually different."
        )
    elif empty_model > 0:
        hints.append(
            f"{empty_model} image(s): model found no similar region (empty mask)."
        )
    if filtered > 0:
        min_area = (settings or {}).get("minArea") or md.get("min_area") or 0
        hints.append(
            f"{filtered} image(s): region(s) detected but removed by min_area={min_area:g} px² — try lowering the filter."
        )
    if outcomes.get("error", 0) > 0:
        hints.append(f"{outcomes['error']} image(s) failed during inference — see sample details below.")

    return {
        "outcomes": outcomes,
        "samples": samples,
        "selfTest": md.get("self_test"),
        "settings": settings
        or {
            "modelSize": md.get("model_size") or "base",
            "imageSize": int(md.get("image_size") or 768),
            "minArea": float(md.get("min_area") or 0),
        },
        "references": references or md.get("reference_diagnostics") or [],
        "hints": hints,
        "pipeline": [
            "Load reference image(s) and rasterize annotation polygon(s) to masks.",
            "Encode references with DINOv3 (INSID3) and compare to each target image.",
            "Run in-context segmentation to produce a similarity mask on the target.",
            "Extract connected components as polygons; discard regions below min_area.",
        ],
    }


def run_insid3_propagate_work(task_id: int) -> None:
    db = SessionLocal()
    try:
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            logger.error("Task %s not found", task_id)
            return
        if task.status == "cancelled":
            return

        md = dict(task.task_metadata or {})
        dataset_id = md.get("dataset_id")
        collection_id = md.get("collection_id")
        references = md.get("references") or []
        exclude_refs = bool(md.get("exclude_reference_images", True))
        target_image_names = md.get("target_image_names") or None

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 0.0
        db.commit()

        layer_images = _resolve_search_images(
            db, int(dataset_id), collection_id, target_image_names
        )
        layer_image_count = (
            len(target_image_names) if target_image_names else len(layer_images)
        )
        images, excluded_reference_count = _apply_reference_exclusion(
            layer_images, references, exclude_refs
        )

        total = len(images)
        md["layer_image_count"] = layer_image_count
        md["excluded_reference_count"] = excluded_reference_count
        md["searchable_image_count"] = total
        md["total"] = total
        md["processed"] = 0
        md["reference_diagnostics"] = _reference_rows_from_payload(references)
        references = _prepare_references(references)
        md["references"] = references
        self_test = _self_test_references(references, md)
        md["self_test"] = self_test
        if self_test.get("diagnostics", {}).get("references"):
            md["reference_diagnostics"] = self_test["diagnostics"]["references"]
        task.task_metadata = md
        flag_modified(task, "task_metadata")
        db.commit()

        if not self_test.get("ok"):
            logger.warning(
                "[INSID3] propagate task %s: reference self-test failed: %s",
                task_id,
                self_test.get("reason"),
            )
            task.status = "completed"
            task.progress = 100.0
            task.completed_at = datetime.utcnow()
            md["results"] = {}
            md["added_count"] = 0
            md["empty_reason"] = "reference_self_test_failed"
            md["stage"] = "completed"
            md["diagnostics_summary"] = _aggregate_batch_diagnostics({}, md)
            task.task_metadata = md
            flag_modified(task, "task_metadata")
            db.commit()
            return

        if total == 0:
            if layer_image_count == 0:
                empty_reason = "no_images_in_layer"
            elif exclude_refs and excluded_reference_count >= layer_image_count:
                empty_reason = "all_reference_images_excluded"
            else:
                empty_reason = "no_searchable_images"
            logger.info(
                "[INSID3] propagate task %s: 0 searchable images "
                "(layer=%s refs_excluded=%s reason=%s)",
                task_id,
                layer_image_count,
                excluded_reference_count,
                empty_reason,
            )
            task.status = "completed"
            task.progress = 100.0
            task.completed_at = datetime.utcnow()
            md["results"] = {}
            md["added_count"] = 0
            md["empty_reason"] = empty_reason
            md["stage"] = "completed"
            task.task_metadata = md
            flag_modified(task, "task_metadata")
            db.commit()
            return

        results: Dict[str, Any] = md.get("results") or {}
        added_count = int(md.get("added_count") or 0)

        for idx, img in enumerate(images):
            if task.status == "cancelled":
                break
            media_url = resolve_media_url(img.url)
            b64, tw, th = _load_image_b64_and_size(media_url or img.url)
            if not b64:
                results[img.file_name] = {"error": "failed to fetch image", "polygons": []}
                continue
            try:
                out = _call_insid3(
                    references,
                    b64,
                    tw,
                    th,
                    md,
                )
                polys = out.get("polygons") or []
                entry: Dict[str, Any] = {"polygons": polys}
                if out.get("diagnostics"):
                    entry["diagnostics"] = out["diagnostics"]
                if polys:
                    results[img.file_name] = entry
                    added_count += len(polys)
                else:
                    results[img.file_name] = entry
            except Exception as e:
                logger.warning("INSID3 failed for %s: %s", img.file_name, e)
                results[img.file_name] = {"error": str(e), "polygons": []}

            task.progress = round(((idx + 1) / total) * 100.0, 1)
            md["results"] = results
            md["added_count"] = added_count
            md["processed"] = idx + 1
            task.task_metadata = md
            flag_modified(task, "task_metadata")
            db.commit()

        if task.status != "cancelled":
            task.status = "completed"
            task.progress = 100.0
            task.completed_at = datetime.utcnow()
            md["stage"] = "completed"
            md["searchable_image_count"] = total
            md["total"] = total
            md["diagnostics_summary"] = _aggregate_batch_diagnostics(results, md)
            task.task_metadata = md
            flag_modified(task, "task_metadata")
            db.commit()
    except Exception as e:
        logger.exception("insid3_propagate task %s failed", task_id)
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if task and task.status != "cancelled":
            task.status = "failed"
            task.error_message = str(e)
            task.completed_at = datetime.utcnow()
            db.commit()
        raise
    finally:
        db.close()
