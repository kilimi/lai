"""Predictions HTTP routes — delegates to predictions_service."""
from fastapi import APIRouter
from app.services import predictions_service as svc

router = APIRouter()

router.post("/predictions/evaluate")(getattr(svc, "evaluate_model"))
router.post("/predictions/evaluate-multiple")(getattr(svc, "evaluate_model_multiple_datasets"))
router.get("/predictions/evaluation-blobs/{task_id}")(getattr(svc, "get_evaluation_blobs"))
router.get("/predictions/evaluation-image/{task_id}/{image_id}")(getattr(svc, "get_evaluation_image"))
router.get("/predictions/export-coco/{task_id}")(getattr(svc, "export_coco_results"))
router.post("/predictions/evaluation/{task_id}/save-to-dataset")(getattr(svc, "save_evaluation_predictions_to_dataset"))
router.post("/predictions/save-to-dataset/{task_id}")(getattr(svc, "save_evaluation_predictions_to_dataset_legacy"))
router.get("/predictions/export-coco-all/{task_id}")(getattr(svc, "export_all_coco_results"))
router.post("/predictions/view-fiftyone/{task_id}")(getattr(svc, "view_in_fiftyone"))
