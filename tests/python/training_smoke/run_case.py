#!/usr/bin/env python3
"""Run one training smoke case inside worker-gpu (invoked via docker compose exec)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

TESTS_PYTHON = Path(__file__).resolve().parent.parent
if str(TESTS_PYTHON) not in sys.path:
    sys.path.insert(0, str(TESTS_PYTHON))

from training_smoke.compose_probe import DEFAULT_WORKSPACE  # noqa: E402
from training_smoke.fixtures import (  # noqa: E402
    assert_training_artifacts,
    build_training_config,
    create_test_engine,
    iter_training_smoke_cases,
    run_training_smoke,
    seed_car_dataset,
)


def _find_case(case_id: str):
    for case in iter_training_smoke_cases():
        if case.id == case_id:
            return case
    return None


def init_workspace(workspace: Path) -> dict:
    workspace.mkdir(parents=True, exist_ok=True)
    projects_root = workspace / "projects"
    projects_root.mkdir(parents=True, exist_ok=True)

    engine, Session = create_test_engine(workspace)
    from app.database import Base

    Base.metadata.create_all(bind=engine)
    db = Session()
    old_projects_root = os.environ.get("LAI_PROJECTS_ROOT")
    try:
        os.chdir(workspace)
        os.environ["LAI_PROJECTS_ROOT"] = str(projects_root.resolve())
        seed_info = seed_car_dataset(db, projects_root=projects_root)
        return {
            "workspace": str(workspace),
            "projects_root": str(projects_root),
            "seed": seed_info,
        }
    finally:
        if old_projects_root is None:
            os.environ.pop("LAI_PROJECTS_ROOT", None)
        else:
            os.environ["LAI_PROJECTS_ROOT"] = old_projects_root
        db.close()


def _require_gpu_cli() -> None:
    import torch

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for training smoke tests")


def _require_ultralytics_cli() -> None:
    if __import__("importlib").util.find_spec("ultralytics") is None:
        raise SystemExit("ultralytics is not installed")


def _require_mmyolo_cli() -> None:
    import subprocess
    from pathlib import Path

    mmyolo_py = Path(os.environ.get("MMYOLO_PYTHON", "/opt/conda/envs/mmyolo/bin/python"))
    if not mmyolo_py.is_file():
        raise SystemExit(f"MMYOLO_PYTHON not found: {mmyolo_py}")
    proc = subprocess.run(
        [str(mmyolo_py), "-m", "mim", "--version"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise SystemExit(f"mim is not available in {mmyolo_py}: {err[:500]}")


def run_case(workspace: Path, case_id: str) -> dict:
    case = _find_case(case_id)
    if case is None:
        raise SystemExit(f"Unknown training smoke case: {case_id}")

    _require_gpu_cli()
    if case.backend_id.startswith("ultralytics"):
        _require_ultralytics_cli()
    if case.backend_id == "mmyolo":
        _require_mmyolo_cli()

    projects_root = workspace / "projects"
    engine, Session = create_test_engine(workspace)
    db = Session()
    old_projects_root = os.environ.get("LAI_PROJECTS_ROOT")
    try:
        os.chdir(workspace)
        os.environ["LAI_PROJECTS_ROOT"] = str(projects_root.resolve())
        seed_info = seed_car_dataset(db, projects_root=projects_root)
        training_config = build_training_config(case, seed_info)
        task_id = run_training_smoke(
            db,
            case,
            training_config,
            projects_root=projects_root,
            session_factory=Session,
        )
        assert_training_artifacts(db, task_id, projects_root=projects_root)
        return {"success": True, "case_id": case_id, "task_id": task_id}
    finally:
        if old_projects_root is None:
            os.environ.pop("LAI_PROJECTS_ROOT", None)
        else:
            os.environ["LAI_PROJECTS_ROOT"] = old_projects_root
        db.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Training smoke runner (worker-gpu)")
    parser.add_argument(
        "--workspace",
        default=os.environ.get("LAI_TRAINING_SMOKE_WORKSPACE", DEFAULT_WORKSPACE),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Seed car_dataset workspace")

    run_p = sub.add_parser("run", help="Run one catalog case")
    run_p.add_argument("--case-id", required=True)

    args = parser.parse_args(argv)
    workspace = Path(args.workspace)

    if args.command == "init":
        info = init_workspace(workspace)
        print(json.dumps(info))
        return 0

    if args.command == "run":
        result = run_case(workspace, args.case_id)
        print(json.dumps(result))
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
