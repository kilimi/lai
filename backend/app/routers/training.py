"""Training HTTP routes — delegates to training_operations_service."""
from __future__ import annotations

from fastapi import APIRouter
from app.services import training_operations_service as ops

router = APIRouter()

router.post("/training/import")(getattr(ops, "import_model"))
router.post("/training/yolo/start")(getattr(ops, "start_yolo_training"))
router.post("/training/{task_id}/rerun")(getattr(ops, "rerun_training"))
router.get("/training/task/{task_id}/status")(getattr(ops, "get_training_status"))
router.post("/training/rtdetr")(getattr(ops, "start_rtdetr_training"))
router.get("/training/{task_id}/checkpoints")(getattr(ops, "list_checkpoints"))
router.get("/training/{task_id}/download")(getattr(ops, "download_checkpoint"))
router.post("/training/{task_id}/test-inference")(getattr(ops, "test_training_model_inference"))
router.post("/training/mmyolo/dji-patch")(getattr(ops, "upload_mmyolo_dji_patch"))
router.post("/training/mmyolo")(getattr(ops, "start_mmyolo_training"))
