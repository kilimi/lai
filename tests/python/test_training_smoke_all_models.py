"""
End-to-end training smoke tests for every registered model backend variant.

Uses the fixed fixture dataset:
  tests/python/test_dataset/car_dataset/
    *.jpg
    cars_export.json

Each test trains for 5 epochs (override with LAI_TRAINING_SMOKE_EPOCHS) and asserts:
  - task completes successfully
  - training metrics are persisted (metrics_history / results.csv / latest_metrics)
  - at least one checkpoint file is written (best/last .pt or MMYOLO .pth)

Requirements:
  - Run on worker-gpu (/app is the backend tree). Host tests are mounted at /tests (compose volume).
  - From repo root (PowerShell; exec cannot take -v):
      docker compose exec -e LAI_RUN_TRAINING_SMOKE=1 -e LAI_BACKEND_DIR=/app worker-gpu bash -lc \\
        'pip install -q pytest && pytest /tests/python/test_training_smoke_all_models.py -m training_smoke -v'

Filter models (optional):
  LAI_TRAINING_SMOKE_MODELS=yolo/yolo11n-seg.pt,mmyolo/rtmdet_s

Skip slow full matrix in CI unless explicitly enabled:
  LAI_RUN_TRAINING_SMOKE=1
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

PYTHON_TESTS = Path(__file__).resolve().parent

from training_smoke.fixtures import (  # noqa: E402
    CAR_DATASET_DIR,
    build_training_config,
    create_test_engine,
    iter_training_smoke_cases,
    require_gpu,
    require_mmyolo_runtime,
    require_ultralytics,
    run_training_smoke,
    seed_car_dataset,
    assert_training_artifacts,
)

pytestmark = [
    pytest.mark.training_smoke,
    pytest.mark.gpu,
    pytest.mark.slow,
    pytest.mark.skipif(
        os.environ.get("LAI_RUN_TRAINING_SMOKE", "").lower() not in ("1", "true", "yes"),
        reason="Set LAI_RUN_TRAINING_SMOKE=1 to run GPU training smoke tests",
    ),
]


def _training_cases():
    if not CAR_DATASET_DIR.is_dir():
        return []
    return list(iter_training_smoke_cases())


@pytest.fixture(scope="module")
def training_workspace(tmp_path_factory):
    """Module-scoped projects root + DB seeded once from car_dataset."""
    root = tmp_path_factory.mktemp("training_smoke")
    projects_root = root / "projects"
    projects_root.mkdir(parents=True, exist_ok=True)

    engine, Session = create_test_engine(root)
    from app.database import Base

    Base.metadata.create_all(bind=engine)
    db = Session()
    old_projects_root = os.environ.get("LAI_PROJECTS_ROOT")
    try:
        old_cwd = Path.cwd()
        os.chdir(projects_root.parent)
        os.environ["LAI_PROJECTS_ROOT"] = str(projects_root.resolve())
        seed_info = seed_car_dataset(db, projects_root=projects_root)
        yield {
            "root": root,
            "projects_root": projects_root,
            "db": db,
            "Session": Session,
            "seed": seed_info,
        }
    finally:
        os.chdir(old_cwd)
        if old_projects_root is None:
            os.environ.pop("LAI_PROJECTS_ROOT", None)
        else:
            os.environ["LAI_PROJECTS_ROOT"] = old_projects_root
        db.close()


@pytest.fixture()
def db_session(training_workspace):
    db = training_workspace["Session"]()
    try:
        yield db
    finally:
        db.close()


@pytest.mark.parametrize(
    "case",
    _training_cases(),
    ids=[c.id for c in _training_cases()] or ["no-catalog"],
)
def test_train_model_smoke(case, training_workspace, db_session):
    """Train one catalog variant for 5 epochs on car_dataset; verify metrics and checkpoints."""
    if not _training_cases():
        pytest.skip(f"car_dataset not found at {CAR_DATASET_DIR}")

    require_gpu()
    if case.backend_id.startswith("ultralytics"):
        require_ultralytics()
    if case.backend_id == "mmyolo":
        require_mmyolo_runtime()

    seed = training_workspace["seed"]
    projects_root = training_workspace["projects_root"]
    training_config = build_training_config(case, seed)

    old_cwd = Path.cwd()
    try:
        os.chdir(projects_root.parent)
        task_id = run_training_smoke(
            db_session,
            case,
            training_config,
            projects_root=projects_root,
            session_factory=training_workspace["Session"],
        )
        assert_training_artifacts(db_session, task_id, projects_root=projects_root)
    finally:
        os.chdir(old_cwd)


def test_training_smoke_catalog_non_empty():
    """Guard: at least one trainable variant is registered."""
    cases = _training_cases()
    if not CAR_DATASET_DIR.is_dir():
        pytest.skip(f"car_dataset not found at {CAR_DATASET_DIR}")
    assert len(cases) >= 3
    backend_ids = {c.backend_id for c in cases}
    assert "ultralytics.yolo" in backend_ids
    assert "ultralytics.rtdetr" in backend_ids
    assert "mmyolo" in backend_ids
