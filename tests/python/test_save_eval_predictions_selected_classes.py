from types import SimpleNamespace
from unittest.mock import patch

from app import models
from app.services.predictions_service import build_thresholded_evaluation_coco_bundle


class FakeQuery:
    def __init__(self, items):
        self._items = list(items)

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._items[0] if self._items else None

    def all(self):
        return self._items


class FakeSession:
    def __init__(self, dataset, images):
        self.dataset = dataset
        self.images = list(images)

    def query(self, model):
        if model is models.Dataset:
            return FakeQuery([self.dataset])
        if model is models.Image:
            return FakeQuery(self.images)
        raise AssertionError(f"Unexpected model queried: {model}")


def test_cm_cell_save_keeps_only_selected_classes_without_background_or_unselected_categories():
    task = SimpleNamespace(
        id=77,
        task_type="model_evaluation",
        status="completed",
        name="eval_77",
        task_metadata={"results": {"artifact": "ignored_by_test"}},
    )

    dataset = SimpleNamespace(id=5, name="test_dataset")
    images = [
        SimpleNamespace(
            id=10,
            dataset_id=5,
            collection_id=None,
            file_name="image_10.jpg",
            width=640,
            height=480,
            uploaded_at=None,
        )
    ]
    db = FakeSession(dataset=dataset, images=images)

    # Select only the dog TP cell (row=1, col=1). The background class is class_id=2.
    merged_results = {
        "predictions": [
            {"image_id": 10, "class_id": 0, "bbox": [0, 0, 20, 20], "conf": 0.95},
            {"image_id": 10, "class_id": 1, "bbox": [30, 30, 20, 20], "conf": 0.97},
            {"image_id": 10, "class_id": 2, "bbox": [50, 50, 20, 20], "conf": 0.99},
        ],
        "all_ground_truth": [
            {"image_id": 10, "class_id": 0, "bbox": [0, 0, 20, 20]},
            {"image_id": 10, "class_id": 1, "bbox": [30, 30, 50, 50]},
        ],
        "dataset_id": 5,
        "collection_id": None,
        "class_names": ["cat", "dog", "background"],
        "checkpoint": "best",
        "conf_threshold": 0.25,
        "iou_threshold": 0.5,
    }

    with patch(
        "app.services.predictions_service.load_merged_evaluation_results",
        return_value=merged_results,
    ):
        coco_output, _, _, _ = build_thresholded_evaluation_coco_bundle(
            db=db,
            task=task,
            task_id=77,
            conf_threshold=0.25,
            iou_threshold=0.5,
            per_class_conf_dict=None,
            save_selection="cm_cells",
            selected_class_ids=None,
            selected_cells=[[1, 1]],
        )

    annotation_class_ids = {ann["category_id"] for ann in coco_output["annotations"]}
    category_ids = {cat["id"] for cat in coco_output["categories"]}

    assert annotation_class_ids == {1}
    assert category_ids == {1}
    assert 2 not in annotation_class_ids
    assert 2 not in category_ids
