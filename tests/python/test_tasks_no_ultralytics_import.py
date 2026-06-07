"""Task modules on the general worker must not import ultralytics at module level."""
from pathlib import Path

FORBIDDEN = ("from ultralytics", "import ultralytics")

GENERAL_TASK_MODULES = [
    "dataset_tasks.py",
    "augmentation_tasks.py",
    "backup_tasks.py",
    "task_monitoring.py",
    "annotation_tasks.py",
    "depth_estimation_tasks.py",
    "maintenance_tasks.py",
]


def test_general_task_modules_avoid_top_level_ultralytics():
    tasks_dir = Path(__file__).resolve().parents[2] / "backend" / "app" / "tasks"
    for name in GENERAL_TASK_MODULES:
        text = (tasks_dir / name).read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            for pattern in FORBIDDEN:
                assert pattern not in stripped, f"{name} must not use top-level {pattern!r}"
