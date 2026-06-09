#!/usr/bin/env python3
"""Extract predictions router logic into predictions_service."""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROUTER = REPO / "backend" / "app" / "routers" / "predictions.py"
SERVICE = REPO / "backend" / "app" / "services" / "predictions_service.py"

ROUTES = [
    ("post", "/predictions/evaluate", "evaluate_model"),
    ("post", "/predictions/evaluate-multiple", "evaluate_model_multiple_datasets"),
    ("get", "/predictions/evaluation-blobs/{task_id}", "get_evaluation_blobs"),
    ("get", "/predictions/evaluation-image/{task_id}/{image_id}", "get_evaluation_image"),
    ("get", "/predictions/export-coco/{task_id}", "export_coco_results"),
    ("post", "/predictions/evaluation/{task_id}/save-to-dataset", "save_evaluation_predictions_to_dataset"),
    ("post", "/predictions/save-to-dataset/{task_id}", "save_evaluation_predictions_to_dataset_legacy"),
    ("get", "/predictions/export-coco-all/{task_id}", "export_all_coco_results"),
    ("post", "/predictions/view-fiftyone/{task_id}", "view_in_fiftyone"),
]


def _strip_router_decorators(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    skip = False
    for line in lines:
        if line.startswith("@router."):
            skip = True
            continue
        if skip:
            skip = False
        out.append(line)
    return "\n".join(out) + "\n"


def build_service(source_lines: list[str]) -> str:
    start = next(i for i, l in enumerate(source_lines) if l.startswith("def _slug_for_attachment_filename"))
    block = "\n".join(source_lines[start:])
    block = _strip_router_decorators(block)
    block = block.replace("from ..database import", "from app.database import")
    block = block.replace("from ..evaluation_artifacts import", "from app.evaluation_artifacts import")
    block = block.replace("from ..dataset_media_paths import", "from app.dataset_media_paths import")
    block = block.replace("from ..models import", "from app.models import")
    header = '''"""Model evaluation and prediction export (service layer)."""
from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.dataset_media_paths import resolve_dataset_image_path_from_models
from app.evaluation_artifacts import load_merged_evaluation_results
from app.models import Dataset, Image, ImageCollection, Task

logger = logging.getLogger(__name__)

'''
    return header + block


def build_router() -> str:
    lines = [
        '"""Predictions HTTP routes — delegates to predictions_service."""\n',
        "from fastapi import APIRouter\n",
        "from app.services import predictions_service as svc\n",
        "\n",
        "router = APIRouter()\n",
        "\n",
    ]
    for method, path, name in ROUTES:
        lines.append(f'router.{method}("{path}")(getattr(svc, "{name}"))\n')
    return "".join(lines)


def main() -> None:
    source_lines = ROUTER.read_text(encoding="utf-8").splitlines()
    SERVICE.write_text(build_service(source_lines), encoding="utf-8")
    ROUTER.write_text(build_router(), encoding="utf-8")
    print("wrote", SERVICE.name, SERVICE.read_text(encoding="utf-8").count("\n"), "lines")
    print("wrote", ROUTER.name, ROUTER.read_text(encoding="utf-8").count("\n"), "lines")


if __name__ == "__main__":
    main()
