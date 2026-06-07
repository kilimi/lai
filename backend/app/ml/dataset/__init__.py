"""Dataset preparation for model training."""
from app.ml.dataset.formats.coco import prepare_coco_dataset

__all__ = ["prepare_coco_dataset", "prepare_yolo_dataset", "prepare_mmyolo_dataset"]


def prepare_mmyolo_dataset(db, dataset_configs, output_dir, task="detect", remove_images_without_annotations=True):
    """Backward-compatible alias for MMYOLO COCO dataset preparation."""
    return prepare_coco_dataset(
        db,
        dataset_configs,
        output_dir,
        task=task,
        remove_images_without_annotations=remove_images_without_annotations,
    )


def prepare_yolo_dataset(*args, **kwargs):
    """Lazy import to avoid pulling SQLAlchemy models when only COCO prep is needed."""
    from app.ml.dataset.formats.yolo import prepare_yolo_dataset as _prepare

    return _prepare(*args, **kwargs)
