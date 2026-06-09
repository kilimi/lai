#!/usr/bin/env python3
"""Move annotation_db implementation into app.services.annotation_processing."""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROUTER = REPO / "backend" / "app" / "routers" / "annotation_db.py"
PROCESSING = REPO / "backend" / "app" / "services" / "annotation_processing.py"
ROUTES = [
    ('post', '/datasets/{dataset_id}/annotations/upload-coco', 'upload_coco_annotation_file'),
    ('post', '/datasets/{dataset_id}/annotations/save-direct', 'save_annotations_direct'),
    ('get', '/datasets/{dataset_id}/annotations/{annotation_file_id}/data', 'get_annotation_data'),
    ('get', '/datasets/{dataset_id}/annotations/{annotation_file_id}/image-annotations', 'get_annotations_for_image'),
    ('get', '/datasets/{dataset_id}/annotations/{annotation_file_id}/classes', 'get_annotation_classes'),
    ('get', '/datasets/{dataset_id}/annotations/{annotation_file_id}/status', 'get_processing_status'),
    ('put', '/datasets/{dataset_id}/annotations/{annotation_file_id}/annotation/{annotation_id}', 'update_annotation'),
    ('delete', '/datasets/{dataset_id}/annotations/{annotation_file_id}/class/{class_name}', 'delete_class_annotations'),
    ('post', '/datasets/{dataset_id}/annotations/recalculate-count', 'recalculate_dataset_annotation_count'),
    ('post', '/datasets/recalculate-all-counts', 'recalculate_all_dataset_annotation_counts'),
]


def build_processing_module(source: str) -> str:
    lines = source.splitlines()
    out: list[str] = []
    skip_router_line = False
    for line in lines:
        if line.strip() == "router = APIRouter()":
            continue
        if line.startswith("@router."):
            skip_router_line = True
            continue
        if skip_router_line:
            skip_router_line = False
        out.append(line)

    text = "\n".join(out) + "\n"
    text = text.replace("from ..database import get_db\n", "")
    text = text.replace("from ..database import SessionLocal\n", "from app.database import SessionLocal\n")
    text = text.replace("from ..models import", "from app.models import")
    text = text.replace("from ..task_stop import", "from app.task_stop import")
    text = re.sub(
        r'^from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query$',
        "from fastapi import Depends, HTTPException, UploadFile, File, Query",
        text,
        flags=re.MULTILINE,
    )
    header = '"""COCO annotation persistence and processing (service layer)."""\nfrom __future__ import annotations\n\n'
    if not text.lstrip().startswith('"""'):
        text = header + text.lstrip()
    return text


def build_router_module() -> str:
    lines = [
        '"""HTTP routes for annotation DB — delegates to annotation_processing."""\n',
        "from fastapi import APIRouter\n",
        "from app.services import annotation_processing as proc\n",
        "\n",
        "router = APIRouter()\n",
        "\n",
    ]
    for method, path, name in ROUTES:
        lines.append(f"router.{method}(\"{path}\")(getattr(proc, \"{name}\"))\n")
    return "".join(lines)


def main() -> None:
    source = ROUTER.read_text(encoding="utf-8")
    PROCESSING.write_text(build_processing_module(source), encoding="utf-8")
    ROUTER.write_text(build_router_module(), encoding="utf-8")
    print(f"wrote {PROCESSING} ({PROCESSING.read_text(encoding='utf-8').count(chr(10))} lines)")
    print(f"wrote {ROUTER} ({ROUTER.read_text(encoding='utf-8').count(chr(10))} lines)")


if __name__ == "__main__":
    main()
