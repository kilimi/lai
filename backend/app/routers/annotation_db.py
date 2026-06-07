"""HTTP routes for annotation DB — delegates to annotation_processing."""
from fastapi import APIRouter
from app.services import annotation_processing as proc

router = APIRouter()

router.post("/datasets/{dataset_id}/annotations/upload-coco")(getattr(proc, "upload_coco_annotation_file"))
router.post("/datasets/{dataset_id}/annotations/save-direct")(getattr(proc, "save_annotations_direct"))
router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/data")(getattr(proc, "get_annotation_data"))
router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/image-annotations")(getattr(proc, "get_annotations_for_image"))
router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/classes")(getattr(proc, "get_annotation_classes"))
router.get("/datasets/{dataset_id}/annotations/{annotation_file_id}/status")(getattr(proc, "get_processing_status"))
router.put("/datasets/{dataset_id}/annotations/{annotation_file_id}/annotation/{annotation_id}")(getattr(proc, "update_annotation"))
router.delete("/datasets/{dataset_id}/annotations/{annotation_file_id}/class/{class_name}")(getattr(proc, "delete_class_annotations"))
router.post("/datasets/{dataset_id}/annotations/recalculate-count")(getattr(proc, "recalculate_dataset_annotation_count"))
router.post("/datasets/recalculate-all-counts")(getattr(proc, "recalculate_all_dataset_annotation_counts"))
