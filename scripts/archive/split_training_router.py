#!/usr/bin/env python3
"""Extract training router logic into service modules."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROUTER = REPO / "backend" / "app" / "routers" / "training.py"
SCHEMAS = REPO / "backend" / "app" / "services" / "training_schemas.py"
OPS = REPO / "backend" / "app" / "services" / "training_operations_service.py"

ROUTES = [
    ("post", "/training/import", "import_model"),
    ("post", "/training/yolo/start", "start_yolo_training"),
    ("post", "/training/{task_id}/rerun", "rerun_training"),
    ("get", "/training/task/{task_id}/status", "get_training_status"),
    ("post", "/training/rtdetr", "start_rtdetr_training"),
    ("get", "/training/{task_id}/checkpoints", "list_checkpoints"),
    ("get", "/training/{task_id}/download", "download_checkpoint"),
    ("post", "/training/{task_id}/test-inference", "test_training_model_inference"),
    ("post", "/training/mmyolo/dji-patch", "upload_mmyolo_dji_patch"),
    ("post", "/training/mmyolo", "start_mmyolo_training"),
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


def _fix_imports(text: str) -> str:
    text = text.replace("from ..database import", "from app.database import")
    text = text.replace("from ..models import", "from app.models import")
    text = text.replace("from ..model_weights_presence import", "from app.model_weights_presence import")
    return text


def extract_schemas(source_lines: list[str]) -> str:
    start = next(i for i, l in enumerate(source_lines) if l.startswith("class YoloTrainingRequest"))
    end = next(i for i, l in enumerate(source_lines) if l.startswith("# prepare_mmyolo_dataset"))
    block = source_lines[start:end]
    header = '''"""Pydantic request models for training APIs."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, field_validator, model_validator

from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name

'''
    return header + "\n".join(block) + "\n"


def extract_operations(source_lines: list[str]) -> str:
    start = next(i for i, l in enumerate(source_lines) if l.startswith("def _normalize_class_names"))
    block = "\n".join(source_lines[start:])
    block = _strip_router_decorators(block)
    block = _fix_imports(block)
    header = '''"""Training operations (extracted from training router)."""
from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.ml.dataset import prepare_mmyolo_dataset, prepare_yolo_dataset
from app.ml.mmyolo_catalog import MMYOLO_VALID_ARCHS, MMYOLO_VALID_SIZES, mmyolo_config_name
from app.ml.task_metadata import merge_task_metadata
from app.model_weights_presence import WEIGHTS_DOWNLOAD_NOTICE, is_training_base_weights_cached
from app.models import (
    Annotation,
    AnnotationClass,
    AnnotationFile,
    Dataset,
    Image,
    ImageCollection,
    Project,
    Task,
)
from app.services.training_checkpoints_service import (
    build_checkpoint_zip_response,
    list_training_checkpoints,
    resolve_checkpoint_path,
)
from app.services.training_schemas import (
    MMYOLOTrainingRequest,
    RTDETRTrainingRequest,
    YoloTrainingRequest,
)
from app.services.training_service import dispatch_training
from app.tasks.yolo_training_helpers import generate_safe_output_filename

logger = logging.getLogger(__name__)

USE_CELERY = os.environ.get("USE_CELERY", "true").lower() == "true"
celery_train_task = None
celery_rtdetr_task = None
celery_mmyolo_task = None

if USE_CELERY:
    try:
        from app.tasks.yolo_training import train_yolo_model as celery_train_task
        from app.tasks.rtdetr_training import train_rtdetr_model as celery_rtdetr_task
        from app.tasks.mmyolo_training import train_mmyolo_model as celery_mmyolo_task
        logger.info("Celery task queue enabled for training")
    except ImportError as e:
        logger.warning("Celery not available: %s. Set USE_CELERY=false to disable.", e)
        USE_CELERY = False

'''
    return header + block


def build_router() -> str:
    lines = [
        '"""Training HTTP routes — delegates to training_operations_service."""\n',
        "from __future__ import annotations\n\n",
        "from fastapi import APIRouter\n",
        "from app.services import training_operations_service as ops\n",
        "\n",
        "router = APIRouter()\n",
        "\n",
    ]
    for method, path, name in ROUTES:
        lines.append(f'router.{method}("{path}")(getattr(ops, "{name}"))\n')
    return "".join(lines)


def main() -> None:
    source_lines = ROUTER.read_text(encoding="utf-8").splitlines()
    SCHEMAS.write_text(extract_schemas(source_lines), encoding="utf-8")
    OPS.write_text(extract_operations(source_lines), encoding="utf-8")
    ROUTER.write_text(build_router(), encoding="utf-8")
    print("wrote", SCHEMAS.name, SCHEMAS.read_text(encoding="utf-8").count("\n"), "lines")
    print("wrote", OPS.name, OPS.read_text(encoding="utf-8").count("\n"), "lines")
    print("wrote", ROUTER.name, ROUTER.read_text(encoding="utf-8").count("\n"), "lines")


if __name__ == "__main__":
    main()
