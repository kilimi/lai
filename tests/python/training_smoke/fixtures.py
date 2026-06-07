"""Shared fixtures: seed car_dataset into SQLite and run training jobs."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional
from unittest.mock import MagicMock

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from path_utils import resolve_backend_dir, resolve_python_tests_dir

PYTHON_TESTS = resolve_python_tests_dir()
BACKEND_ROOT = resolve_backend_dir()
CAR_DATASET_DIR = PYTHON_TESTS / "test_dataset" / "car_dataset"
CAR_COCO_FILE = CAR_DATASET_DIR / "cars_export.json"

TRAINING_SMOKE_EPOCHS = int(os.environ.get("LAI_TRAINING_SMOKE_EPOCHS", "5"))
TRAINING_SMOKE_BATCH = int(os.environ.get("LAI_TRAINING_SMOKE_BATCH", "2"))
TRAINING_SMOKE_IMGSZ = int(os.environ.get("LAI_TRAINING_SMOKE_IMGSZ", "640"))


@dataclass(frozen=True)
class TrainingSmokeCase:
    """One training backend + model variant to exercise."""

    id: str
    backend_id: str
    display_name: str
    task_type: str
    extra: Dict[str, Any]


def _mmyolo_task_for_arch(arch: str) -> str:
    if arch == "rtmdet-ins":
        return "segment"
    if arch == "rtmdet-r":
        return "oriented"
    return "detect"


def iter_training_smoke_cases() -> Iterator[TrainingSmokeCase]:
    """All trainable catalog variants (classification excluded)."""
    import sys

    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    from app.ml.registry import get_backend, list_backends
    from app.ml.schemas import VisionTask

    allow = os.environ.get("LAI_TRAINING_SMOKE_MODELS", "").strip()
    allowed = {s.strip() for s in allow.split(",") if s.strip()} if allow else None

    for info in list_backends():
        backend = get_backend(info.id)
        catalog = backend.catalog()
        legacy = backend.legacy_task_types()
        task_type = legacy[0] if legacy else "training"

        for variant in catalog.variants:
            if variant.task == VisionTask.CLASSIFY:
                continue

            if info.id == "mmyolo":
                arch = variant.metadata.get("arch", "rtmdet")
                # car_dataset has boxes/segmentation only — skip oriented (OBB) smoke.
                if arch == "rtmdet-r":
                    continue
                size = variant.metadata.get("size", "s")
                case_id = f"mmyolo/{arch}_{size}"
                extra = {
                    "arch": arch,
                    "size": size,
                    "task": _mmyolo_task_for_arch(arch),
                    "config_id": variant.metadata.get("config_id"),
                }
            elif info.id == "ultralytics.rtdetr":
                case_id = f"rtdetr/{variant.id}"
                extra = {"model_type": variant.id}
            else:
                case_id = f"yolo/{variant.id}"
                extra = {"model_type": variant.id}

            if allowed and case_id not in allowed and variant.id not in allowed:
                continue

            yield TrainingSmokeCase(
                id=case_id,
                backend_id=info.id,
                display_name=variant.display_name,
                task_type=task_type,
                extra=extra,
            )


def require_gpu() -> None:
    import pytest
    import torch

    if not torch.cuda.is_available():
        pytest.skip("CUDA is required for training smoke tests")


def require_ultralytics() -> None:
    import pytest

    if __import__("importlib").util.find_spec("ultralytics") is None:
        pytest.skip("ultralytics is not installed")


def require_mmyolo_runtime() -> None:
    import pytest

    mmyolo_py = Path(os.environ.get("MMYOLO_PYTHON", "/opt/conda/envs/mmyolo/bin/python"))
    if not mmyolo_py.is_file():
        pytest.skip(
            f"MMYOLO_PYTHON not found: {mmyolo_py} "
            "(run training smoke inside the worker-gpu image, or set MMYOLO_PYTHON)"
        )
    try:
        proc = subprocess.run(
            [str(mmyolo_py), "-m", "mim", "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        pytest.skip(f"MMYOLO runtime check failed for {mmyolo_py}: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        pytest.skip(f"mim is not available in {mmyolo_py}: {err[:500]}")


@contextmanager
def patch_session_local(session_factory: Callable[[], Session]):
    """
    Training tasks open their own DB via SessionLocal (Postgres in production).
    Point them at the pytest SQLite session factory instead.
    """
    import app.database as database_module

    targets = [database_module]
    for mod_name in (
        "app.tasks.mmyolo_training",
        "app.tasks.yolo_training",
        "app.tasks.rtdetr_training",
    ):
        mod = sys.modules.get(mod_name)
        if mod is not None and hasattr(mod, "SessionLocal"):
            targets.append(mod)

    saved = [(mod, mod.SessionLocal) for mod in targets]
    for mod in targets:
        mod.SessionLocal = session_factory
    try:
        yield
    finally:
        for mod, original in saved:
            mod.SessionLocal = original


def create_test_engine(tmp_path: Path):
    db_path = tmp_path / "training_smoke.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    return engine, sessionmaker(autocommit=False, autoflush=False, bind=engine)


def seed_car_dataset(
    db: Session,
    *,
    projects_root: Path,
    project_id: int = 1,
    dataset_id: int = 1,
) -> Dict[str, Any]:
    """
    Import tests/python/test_dataset/car_dataset into the DB and copy images under projects/.
    """
    import sys

    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    from app.database import Base
    from app.models import AnnotationFile, Dataset, Image, Project
    from app.services.annotation_processing import process_coco_annotation_file

    if not CAR_DATASET_DIR.is_dir():
        raise FileNotFoundError(f"Car dataset folder not found: {CAR_DATASET_DIR}")
    if not CAR_COCO_FILE.is_file():
        raise FileNotFoundError(f"Car COCO annotations not found: {CAR_COCO_FILE}")

    coco_data = json.loads(CAR_COCO_FILE.read_text(encoding="utf-8"))
    image_dir = projects_root / str(project_id) / "datasets" / str(dataset_id) / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    project = Project(id=project_id, name="Training Smoke", description="car_dataset fixture")
    dataset = Dataset(
        id=dataset_id,
        name="car_dataset",
        description="VisDrone cars smoke fixture",
        project_id=project_id,
    )
    db.merge(project)
    db.merge(dataset)
    db.commit()

    for jpg in sorted(CAR_DATASET_DIR.glob("*.jpg")):
        dest = image_dir / jpg.name
        if not dest.exists():
            shutil.copy2(jpg, dest)
        width, height = 640, 480
        for img_entry in coco_data.get("images", []):
            if img_entry.get("file_name") == jpg.name:
                width = int(img_entry.get("width") or width)
                height = int(img_entry.get("height") or height)
                break
        url = f"/static/projects/{project_id}/datasets/{dataset_id}/images/{jpg.name}"
        existing = (
            db.query(Image)
            .filter(Image.dataset_id == dataset_id, Image.file_name == jpg.name)
            .first()
        )
        if existing is None:
            db.add(
                Image(
                    dataset_id=dataset_id,
                    file_name=jpg.name,
                    file_size=dest.stat().st_size,
                    width=width,
                    height=height,
                    url=url,
                )
            )
    db.commit()

    ann_file_id = "car-smoke-af"
    if not db.query(AnnotationFile).filter(AnnotationFile.id == ann_file_id).first():
        db.add(
            AnnotationFile(
                id=ann_file_id,
                dataset_id=dataset_id,
                name=CAR_COCO_FILE.name,
                format="COCO",
                type="segmentation",
                processing_status="pending",
                is_processed=False,
            )
        )
        db.commit()

    asyncio.run(process_coco_annotation_file(ann_file_id, coco_data))

    ann_file = db.query(AnnotationFile).filter(AnnotationFile.id == ann_file_id).first()
    assert ann_file is not None
    assert ann_file.processing_status == "completed"
    assert (ann_file.annotation_count or 0) > 0

    return {
        "project_id": project_id,
        "dataset_id": dataset_id,
        "annotation_file_id": ann_file_id,
        "image_count": len(list(image_dir.glob("*.jpg"))),
        "annotation_count": ann_file.annotation_count,
    }


def build_training_config(
    case: TrainingSmokeCase,
    seed: Dict[str, Any],
    *,
    epochs: int = TRAINING_SMOKE_EPOCHS,
) -> Dict[str, Any]:
    cfg: Dict[str, Any] = {
        "project_id": seed["project_id"],
        "dataset_configs": [
            {
                "dataset_id": seed["dataset_id"],
                "annotation_file_id": seed["annotation_file_id"],
                "split": {"train": 80, "val": 20, "test": 0},
            }
        ],
        "epochs": epochs,
        "batch_size": TRAINING_SMOKE_BATCH,
        "image_size": TRAINING_SMOKE_IMGSZ,
        "imgsz": TRAINING_SMOKE_IMGSZ,
        "device": os.environ.get("LAI_TRAINING_DEVICE", "0"),
        "remove_images_without_annotations": True,
        "patience": epochs + 10,
        "save_period": 1,
    }
    cfg.update(case.extra)
    return cfg


def _write_yolo_data_yaml(output_dir: Path, dataset_info: Dict[str, Any]) -> Path:
    import yaml

    data_yaml = {
        "path": str(output_dir.absolute()),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {i: name for i, name in enumerate(dataset_info["class_names"])},
        "nc": len(dataset_info["class_names"]),
    }
    yaml_path = output_dir / "data.yaml"
    yaml_path.write_text(yaml.safe_dump(data_yaml), encoding="utf-8")
    return yaml_path


def run_training_smoke(
    db: Session,
    case: TrainingSmokeCase,
    training_config: Dict[str, Any],
    *,
    projects_root: Path,
    session_factory: Optional[Callable[[], Session]] = None,
) -> int:
    """Run one training job; return task id."""
    import sys

    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

    from app.models import Task as TaskModel

    task = TaskModel(
        project_id=training_config["project_id"],
        name=f"smoke {case.id}",
        description=f"Training smoke: {case.display_name}",
        task_type=case.task_type,
        status="pending",
        progress=0,
        task_metadata={"framework_id": case.backend_id, "smoke_case_id": case.id},
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    mock_request = MagicMock()
    mock_request.id = f"smoke-{case.id}"

    factory = session_factory
    if factory is None:
        bind = db.get_bind()
        factory = sessionmaker(autocommit=False, autoflush=False, bind=bind)

    def _run_training() -> None:
        if case.backend_id == "ultralytics.yolo":
            from app.tasks.yolo_training import YOLOTrainingTask

            worker = YOLOTrainingTask()
            worker.request = mock_request
            worker.execute(task.id, training_config)

        elif case.backend_id == "ultralytics.rtdetr":
            from app.ml.dataset import prepare_yolo_dataset
            from app.tasks.rtdetr_training import train_rtdetr_model

            output_dir = (
                projects_root / str(training_config["project_id"]) / "training" / f"task_{task.id}"
            )
            output_dir.mkdir(parents=True, exist_ok=True)
            model_type = training_config.get("model_type", "rtdetr-l.pt")
            dataset_info = prepare_yolo_dataset(
                db,
                training_config["dataset_configs"],
                output_dir / "dataset",
                model_type=model_type,
                remove_images_without_annotations=True,
            )
            yaml_path = _write_yolo_data_yaml(output_dir / "dataset", dataset_info)
            rtdetr_config = {
                **training_config,
                "output_dir": str(output_dir),
                "data_yaml": str(yaml_path),
            }
            train_rtdetr_model.run(task.id, rtdetr_config)

        elif case.backend_id == "mmyolo":
            from app.tasks.mmyolo_training import train_mmyolo_model

            train_mmyolo_model.run(task.id, training_config)

        else:
            raise ValueError(f"Unsupported backend: {case.backend_id}")

    with patch_session_local(factory):
        _run_training()

    db.expire_all()
    return task.id


def assert_training_artifacts(db: Session, task_id: int, *, projects_root: Path) -> None:
    """Training finished, metrics persisted, and at least one checkpoint exists."""
    from app.models import Task as TaskModel

    task = db.query(TaskModel).filter(TaskModel.id == task_id).first()
    assert task is not None, f"task {task_id} missing"
    assert task.status == "completed", (
        f"task {task_id} ({task.name}) status={task.status!r} error={task.error_message!r}"
    )

    meta = task.task_metadata if isinstance(task.task_metadata, dict) else {}
    history = meta.get("metrics_history")
    has_metrics = bool(
        (isinstance(history, list) and len(history) > 0)
        or meta.get("latest_metrics")
        or meta.get("results")
    )

    results_dir = meta.get("results_dir")
    if not has_metrics and results_dir:
        training_dir = Path(results_dir)
        if (training_dir / "results.csv").is_file():
            has_metrics = True
    if not has_metrics and meta.get("results_csv"):
        if Path(str(meta["results_csv"])).is_file():
            has_metrics = True

    output_base = projects_root / str(task.project_id) / "training" / f"task_{task_id}"
    if not has_metrics and (output_base / "training" / "results.csv").is_file():
        has_metrics = True

    assert has_metrics, (
        f"task {task_id}: no training metrics in metadata keys={list(meta.keys())} "
        f"results_dir={results_dir!r}"
    )

    checkpoint_paths: List[Path] = []
    for key in ("best_model", "last_model", "resume_from"):
        raw = meta.get(key)
        if raw:
            checkpoint_paths.append(Path(str(raw)))

    search_dirs = []
    if results_dir:
        search_dirs.append(Path(str(results_dir)))
    search_dirs.append(output_base / "training")
    search_dirs.append(output_base / "training" / "weights")

    for directory in search_dirs:
        if not directory.is_dir():
            continue
        for pattern in ("best.pt", "last.pt", "epoch_last.pth"):
            checkpoint_paths.extend(directory.glob(pattern))
        checkpoint_paths.extend(directory.glob("best_*.pth"))

    assert any(p.is_file() for p in checkpoint_paths), (
        f"task {task_id}: no checkpoint files under {search_dirs}"
    )
