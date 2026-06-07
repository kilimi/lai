"""
Celery tasks for YOLO ONNX auto-annotation (/preannotate).
"""
from __future__ import annotations

import logging
from datetime import datetime

from celery import Task

from app.celery.general_app import celery_app
from app.database import SessionLocal
from app import models
from app.routers.preannotate import (
    COCO_CLASSES,
    _auto_annotate_tags,
    create_annotation_file_with_classes,
    finalize_annotation_file,
    load_yolo_onnx_runner,
    process_single_image,
    process_single_image_classification,
)

logger = logging.getLogger(__name__)


class PreannotateTask(Task):
    """Base task for YOLO preannotate with failure handling."""

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        logger.error("YOLO preannotate Celery task %s failed: %s", task_id, exc)
        db = SessionLocal()
        try:
            if args:
                db_task_id = args[0]
                task = db.query(models.Task).filter(models.Task.id == db_task_id).first()
                if task and task.status != "cancelled":
                    task.status = "failed"
                    task.error_message = str(exc)
                    task.completed_at = datetime.utcnow()
                    db.commit()
        finally:
            db.close()


def run_yolo_preannotate_work(
    task_id: int,
    model_name: str,
    dataset_id: int,
    conf_threshold: float = 0.25,
    task_type: str = "detect",
) -> None:
    """Run YOLO ONNX inference over a dataset and write COCO annotations."""
    logger.info("Starting preannotate task %s with model %s", task_id, model_name)

    db = SessionLocal()
    try:
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not task:
            logger.error("Task %s not found", task_id)
            return

        if task.status == "cancelled":
            logger.info("Task %s: cancelled before start", task_id)
            return

        task.status = "running"
        task.started_at = datetime.utcnow()
        task.progress = 0.0
        db.commit()

        dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
        if not dataset:
            raise RuntimeError(f"Dataset {dataset_id} not found")

        md = task.task_metadata or {}
        cid = md.get("collection_id")
        if cid is not None:
            try:
                cid = int(cid)
            except (TypeError, ValueError):
                cid = None

        q_img = db.query(models.Image).filter(models.Image.dataset_id == dataset_id)
        if cid is not None:
            q_img = q_img.filter(models.Image.collection_id == cid)
        images = q_img.order_by(models.Image.id.asc()).all()

        logger.info(
            "Task %s: %s images in dataset %s%s",
            task_id,
            len(images),
            dataset_id,
            f" collection_id={cid}" if cid is not None else "",
        )

        if not images:
            raise RuntimeError("No images found in dataset")

        task.progress = 10.0
        db.commit()

        runner, use_segmentation, is_classification = load_yolo_onnx_runner(
            model_name, task_id, task_type
        )
        task.progress = 20.0
        db.commit()

        annotation_file_name = md.get("annotation_file_name", f"Auto_{model_name}")
        auto_tags = _auto_annotate_tags(model_name, task_type)
        annotation_file_id = create_annotation_file_with_classes(
            db,
            dataset_id,
            annotation_file_name,
            use_segmentation,
            task_id,
            tags=auto_tags,
            is_classification=is_classification,
        )

        total_annotations = 0
        class_counts = {} if is_classification else {name: 0 for name in COCO_CLASSES}
        processed_images = 0
        project_id = dataset.project_id or 0

        for img_idx, img in enumerate(images):
            db.refresh(task)
            if task.status == "cancelled":
                logger.info("Task %s: cancelled during image loop", task_id)
                return

            if is_classification:
                annotations_count = process_single_image_classification(
                    db, runner, img, project_id, annotation_file_id, dataset_id, class_counts
                )
            else:
                annotations_count = process_single_image(
                    db,
                    runner,
                    img,
                    project_id,
                    dataset_id,
                    annotation_file_id,
                    class_counts,
                    conf_threshold=conf_threshold,
                )

            total_annotations += annotations_count
            processed_images += 1

            if (img_idx + 1) % 10 == 0 or (img_idx + 1) == len(images):
                task.progress = 20.0 + (processed_images / len(images)) * 70.0
                db.commit()
                logger.info(
                    "Task %s: processed %s/%s images",
                    task_id,
                    processed_images,
                    len(images),
                )

        finalize_annotation_file(
            db, annotation_file_id, total_annotations, processed_images, class_counts
        )

        task.status = "completed"
        task.progress = 100.0
        task.completed_at = datetime.utcnow()
        task.task_metadata = {
            **(task.task_metadata or {}),
            "total_annotations": total_annotations,
            "processed_images": processed_images,
            "annotation_file_id": annotation_file_id,
        }
        db.commit()
        logger.info("Task %s: completed with %s annotations", task_id, total_annotations)

    except Exception as exc:
        logger.error("Task %s: error — %s", task_id, exc, exc_info=True)
        task = db.query(models.Task).filter(models.Task.id == task_id).first()
        if task and task.status != "cancelled":
            task.status = "failed"
            task.error_message = str(exc)
            task.completed_at = datetime.utcnow()
            db.commit()
        raise
    finally:
        db.close()


@celery_app.task(
    base=PreannotateTask,
    bind=True,
    name="app.tasks.preannotate_tasks.run_yolo_preannotate",
)
def run_yolo_preannotate(
    self,
    task_id: int,
    model_name: str,
    dataset_id: int,
    conf_threshold: float = 0.25,
    task_type: str = "detect",
):
    """Celery entrypoint for YOLO ONNX auto-annotation."""
    run_yolo_preannotate_work(task_id, model_name, dataset_id, conf_threshold, task_type)
