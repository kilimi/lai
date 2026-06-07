#!/usr/bin/env python3
"""Post-process extracted dataset service modules."""
from __future__ import annotations

import re
from pathlib import Path

SERVICES = Path(__file__).resolve().parents[1] / "backend" / "app" / "services"


def fix_common(text: str) -> str:
    text = text.replace(", db: Session = Depends(get_db)", "")
    text = text.replace("db: Session = Depends(get_db),", "db: Session,")
    text = text.replace("db: Session = Depends(get_db)", "db: Session")
    text = re.sub(r"(\n    try:\n)\s*try:\n", r"\1", text)
    text = text.replace("        base_url = public_request_base_url(request)\n\n", "")
    text = text.replace("        base_url = public_request_base_url(request)\n", "")
    return text


def strip_duplicate_db_params(text: str) -> str:
    """Remove accidental duplicate `db: Session` lines in function signatures."""
    return re.sub(
        r"(,\s*\n\s*)db: Session\s*(\n\))",
        r"\2",
        text,
    )


def fix_annotations(text: str) -> str:
    text = strip_duplicate_db_params(text)
    text = text.replace(
        "def get_annotation_file_coverage(dataset_id: int, annotation_file_id: str):",
        "def get_annotation_file_coverage(db: Session, dataset_id: int, annotation_file_id: str) -> dict:",
    )
    text = text.replace(
        "def get_dataset_annotations_coverage(dataset_id: int):",
        "def get_dataset_annotations_coverage(db: Session, dataset_id: int) -> dict:",
    )
    for old, new in (
        (
            "async def import_annotations(\n"
            "    dataset_id: int,\n"
            "    background_tasks: BackgroundTasks,\n"
            "    file: UploadFile = File(...)\n"
            "):",
            "async def import_annotations(\n"
            "    db: Session,\n"
            "    dataset_id: int,\n"
            "    background_tasks: BackgroundTasks,\n"
            "    file: UploadFile,\n"
            ") -> dict:",
        ),
        (
            "async def create_annotation_processing_task(\n"
            "    dataset_id: int,\n"
            "    file: UploadFile = File(...),\n"
            "    annotation_type: Optional[str],\n"
            "    task_name: Optional[str]\n"
            "):",
            "async def create_annotation_processing_task(\n"
            "    db: Session,\n"
            "    dataset_id: int,\n"
            "    file: UploadFile,\n"
            "    annotation_type: Optional[str],\n"
            "    task_name: Optional[str],\n"
            ") -> dict:",
        ),
    ):
        text = text.replace(old, new)
    text = re.sub(
        r"async def get_dataset_annotations_list\(\s*"
        r"dataset_id: int,\s*"
        r"page: int = 1,\s*"
        r"limit: int = 1000,\s*"
        r"annotation_file_id: Optional\[str\] = None,\s*"
        r"db: Session\s*"
        r"\):",
        "async def get_dataset_annotations_list(\n"
        "    db: Session,\n"
        "    dataset_id: int,\n"
        "    page: int = 1,\n"
        "    limit: int = 1000,\n"
        "    annotation_file_id: Optional[str] = None,\n"
        ") -> dict:",
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r"async def get_dataset_annotation_content\(\s*"
        r"dataset_id: int,\s*"
        r"annotation_id: str,\s*"
        r"include_images: bool = True,\s*"
        r"include_annotations: bool = True,\s*"
        r"db: Session,?\s*"
        r"\):",
        "async def get_dataset_annotation_content(\n"
        "    db: Session,\n"
        "    dataset_id: int,\n"
        "    annotation_id: str,\n"
        "    *,\n"
        "    include_images: bool = True,\n"
        "    include_annotations: bool = True,\n"
        ") -> dict:",
        text,
        flags=re.DOTALL,
    )
    for name, extra in (
        ("duplicate_annotation_file", ""),
        ("rename_annotation_file", ",\n    new_name: str"),
        ("update_annotation_tags", ",\n    tags: List[str]"),
        ("update_annotation_content", ",\n    file: UploadFile"),
        ("rename_annotation_class", ",\n    body: dict"),
        ("delete_annotation_class", ",\n    class_name: str"),
        ("update_single_image_annotations", ",\n    image_name: str,\n    request: dict"),
    ):
        text = re.sub(
            rf"async def {name}\(\s*dataset_id: int,\s*annotation_id: str,",
            f"async def {name}(db: Session, dataset_id: int, annotation_id: str{extra}",
            text,
            count=1,
        )
        text = re.sub(
            rf"async def {name}\(db: Session, dataset_id: int, annotation_id: str,\s*"
            rf"db: Session\s*\):",
            f"async def {name}(db: Session, dataset_id: int, annotation_id: str{extra}) -> dict:",
            text,
            count=1,
        )
        # Clean Form(...) leftovers on service layer
        text = text.replace(f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    new_name: str = Form(...),", f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    new_name: str,")
        text = text.replace(f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    tags: List[str] = Form(...),", f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    tags: List[str],")
        text = text.replace(f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    file: UploadFile = File(...),", f"{name}(db: Session, dataset_id: int, annotation_id: str,\n    file: UploadFile,")
    text = text.replace(
        "async def get_dataset_annotations(db: Session, dataset_id: int, include_base64: bool = False) -> dict:",
        "async def get_dataset_annotations(db: Session, dataset_id: int) -> dict:",
    )
    text = text.replace("from fastapi import BackgroundTasks, HTTPException, UploadFile, Request\n",
                        "from fastapi import BackgroundTasks, HTTPException, UploadFile\n")
    return text


def fix_fiftyone(text: str) -> str:
    text = re.sub(
        r"async def view_annotations_in_fiftyone\(\s*"
        r"dataset_id: int,\s*"
        r"body: ViewFiftyOneRequest,\s*"
        r"db: Session\s*"
        r"\):",
        "async def view_annotations_in_fiftyone(\n"
        "    db: Session, dataset_id: int, body: ViewFiftyOneRequest\n) -> dict:",
        text,
        flags=re.DOTALL,
    )
    return text


def main() -> None:
    for path in sorted(SERVICES.glob("dataset_*.py")):
        if path.name in (
            "dataset_paths.py",
            "dataset_media_service.py",
            "dataset_video_service.py",
            "dataset_service.py",
        ):
            continue
        text = path.read_text(encoding="utf-8")
        text = fix_common(text)
        if path.name == "dataset_annotations_service.py":
            text = fix_annotations(text)
        if path.name == "dataset_annotation_merge_service.py":
            if "from app.services.dataset_schemas import" not in text:
                text = text.replace(
                    "from app.database import SessionLocal\n",
                    "from app.database import SessionLocal\n"
                    "from app.services.dataset_schemas import MergeAnnotationFilesRequest\n",
                )
            text = text.replace("    request,\n", "    request: MergeAnnotationFilesRequest,\n")
        if path.name == "dataset_fiftyone_service.py":
            text = fix_fiftyone(text)
        path.write_text(text, encoding="utf-8")
        print("fixed", path.name)


if __name__ == "__main__":
    main()
