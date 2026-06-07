"""List and download training checkpoints."""
from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.models import Task
from app.services.training_task_service import (
    checkpoint_stem,
    is_mmyolo_training_task,
    is_training_task,
    model_download_arcname,
    weights_search_dir,
    extract_class_names,
)


def _append_checkpoint(
    checkpoints: List[dict],
    seen: set,
    *,
    name: str,
    path: str,
    epoch: Optional[int],
) -> None:
    p = Path(path)
    if not p.exists():
        return
    size = p.stat().st_size
    checkpoints.append({"name": name, "path": str(p), "epoch": epoch, "size": size})
    seen.add(name if name in ("best", "last") else p.name)


def _scan_weights_dir(weights_dir: Path, checkpoints: List[dict], seen: set) -> None:
    for checkpoint_file in list(weights_dir.glob("*.pt")) + list(weights_dir.glob("*.pth")):
        if checkpoint_file.name in seen:
            continue
        epoch_match = re.search(r"epoch(\d+)", checkpoint_file.name, re.IGNORECASE)
        epoch = int(epoch_match.group(1)) if epoch_match else None
        size = checkpoint_file.stat().st_size if checkpoint_file.exists() else None
        checkpoints.append(
            {
                "name": checkpoint_file.name,
                "path": str(checkpoint_file),
                "epoch": epoch,
                "size": size,
            }
        )
        seen.add(checkpoint_file.name)


def list_training_checkpoints(task: Task) -> Dict[str, Any]:
    if not is_training_task(task):
        raise HTTPException(status_code=400, detail="Task is not a training task")

    meta = task.task_metadata or {}
    results_dir = meta.get("results_dir")
    yolo_results_dir = meta.get("yolo_results_dir")
    checkpoints: List[dict] = []
    seen: set = set()

    for key, yolo_key, label in (
        ("best_model", "yolo_best_model", "best"),
        ("last_model", "yolo_last_model", "last"),
    ):
        path = meta.get(key)
        if path and Path(path).exists():
            _append_checkpoint(checkpoints, seen, name=label, path=path, epoch=None)
        else:
            ypath = meta.get(yolo_key)
            if ypath:
                _append_checkpoint(checkpoints, seen, name=label, path=ypath, epoch=None)

    if results_dir:
        wdir = weights_search_dir(results_dir)
        if wdir:
            _scan_weights_dir(wdir, checkpoints, seen)
    if yolo_results_dir:
        ydir = Path(yolo_results_dir) / "weights"
        if ydir.exists():
            _scan_weights_dir(ydir, checkpoints, seen)

    checkpoints.sort(key=lambda x: (x["epoch"] if x["epoch"] is not None else 9999, x["name"]))
    return {"success": True, "checkpoints": checkpoints}


def resolve_checkpoint_path(task: Task, checkpoint: str) -> Path:
    if not is_training_task(task):
        raise HTTPException(status_code=400, detail="Task is not a training task")

    meta = task.task_metadata or {}
    results_dir = meta.get("results_dir")
    yolo_results_dir = meta.get("yolo_results_dir")
    model_path: Optional[Path] = None

    if is_mmyolo_training_task(task) and checkpoint in ("best", "last"):
        from app.tasks.mmyolo_evaluation import resolve_mmyolo_checkpoint

        resolved = resolve_mmyolo_checkpoint(meta, checkpoint)
        if resolved and Path(resolved).exists():
            model_path = Path(resolved)

    if model_path is None and checkpoint == "best":
        for key in ("best_model", "yolo_best_model"):
            if meta.get(key):
                model_path = Path(meta[key])
                if model_path.exists():
                    break
    elif model_path is None and checkpoint == "last":
        for key in ("last_model", "yolo_last_model"):
            if meta.get(key):
                model_path = Path(meta[key])
                if model_path.exists():
                    break
    elif model_path is None and results_dir:
        weights_dir = weights_search_dir(results_dir)
        if weights_dir:
            potential = weights_dir / checkpoint
            if potential.exists() and potential.suffix in {".pt", ".pth"}:
                model_path = potential
            else:
                for ext in (".pt", ".pth"):
                    potential = weights_dir / f"{checkpoint}{ext}"
                    if potential.exists():
                        model_path = potential
                        break

    if (model_path is None or not model_path.exists()) and yolo_results_dir:
        yolo_weights_dir = Path(yolo_results_dir) / "weights"
        if yolo_weights_dir.exists():
            potential = yolo_weights_dir / checkpoint
            if potential.exists() and potential.suffix in {".pt", ".pth"}:
                model_path = potential
            else:
                for ext in (".pt", ".pth"):
                    potential = yolo_weights_dir / f"{checkpoint}{ext}"
                    if potential.exists():
                        model_path = potential
                        break

    if not model_path or not model_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Checkpoint '{checkpoint}' not found for task {task.id}",
        )
    return model_path


def build_checkpoint_zip_response(
    task: Task, checkpoint: str, model_path: Path
) -> StreamingResponse:
    meta = task.task_metadata or {}
    safe_filename = re.sub(r'[<>:"/\\|?*]', "_", task.name).strip(". ") or f"model_{task.id}"
    checkpoint_name = checkpoint_stem(checkpoint)
    download_filename = f"{safe_filename}_{checkpoint_name}.zip"
    class_names = extract_class_names(meta)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        model_filename = model_download_arcname(model_path, checkpoint, task)
        zf.write(str(model_path), arcname=model_filename)
        zf.writestr("classes.txt", "\n".join(class_names) + "\n" if class_names else "")
        zf.writestr(
            "classes.json",
            json.dumps({"class_names": class_names}, indent=2),
        )
        zf.writestr(
            "metadata.json",
            json.dumps(
                {
                    "task_id": task.id,
                    "task_name": task.name,
                    "checkpoint": checkpoint_name,
                    "model_file": model_filename,
                },
                indent=2,
            ),
        )
    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{download_filename}"'},
    )
