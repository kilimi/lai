from app.services.annotation_processing import (
    segmentation_to_coco_polygons,
    validate_and_normalize_segmentation,
)


def test_point_pair_yolo_polygon_to_coco_flat():
    yolo = [[1908, 516], [1908, 534], [1890, 552], [1884, 552]]
    polys = segmentation_to_coco_polygons(yolo)
    assert polys == [[1908.0, 516.0, 1908.0, 534.0, 1890.0, 552.0, 1884.0, 552.0]]


def test_triple_wrapped_export_unwraps_to_flat():
    wrapped = [[[1908, 516], [1908, 534], [1890, 552], [1884, 552]]]
    polys = segmentation_to_coco_polygons(wrapped)
    assert polys == [[1908.0, 516.0, 1908.0, 534.0, 1890.0, 552.0, 1884.0, 552.0]]


def test_standard_coco_flat_polygon_list():
    coco = [[10.0, 20.0, 30.0, 40.0, 50.0, 60.0]]
    assert segmentation_to_coco_polygons(coco) == coco


def test_validate_normalizes_point_pairs_to_coco():
    yolo = [[10, 20], [30, 40], [50, 60]]
    validated = validate_and_normalize_segmentation(yolo, image_width=100, image_height=100)
    assert validated == [[10, 20, 30, 40, 50, 60]]


def test_build_thresholded_bundle_flattens_yolo_segmentation():
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
            raise AssertionError(model)

    task = SimpleNamespace(
        id=1,
        task_type="model_evaluation",
        status="completed",
        name="eval",
        task_metadata={"results": {}},
    )
    dataset = SimpleNamespace(id=1, name="ds")
    images = [
        SimpleNamespace(
            id=10,
            dataset_id=1,
            collection_id=None,
            file_name="a.jpg",
            width=2000,
            height=2000,
            uploaded_at=None,
        )
    ]
    db = FakeSession(dataset=dataset, images=images)
    merged = {
        "predictions": [
            {
                "image_id": 10,
                "class_id": 0,
                "bbox": [100, 100, 50, 50],
                "conf": 0.9,
                "segmentation": [[1908, 516], [1908, 534], [1890, 552], [1884, 552]],
            }
        ],
        "all_ground_truth": [],
        "dataset_id": 1,
        "collection_id": None,
        "class_names": ["obj"],
        "checkpoint": "best",
        "conf_threshold": 0.25,
        "iou_threshold": 0.5,
    }

    with patch(
        "app.services.predictions_service.load_merged_evaluation_results",
        return_value=merged,
    ):
        coco_output, _, _, _ = build_thresholded_evaluation_coco_bundle(
            db=db,
            task=task,
            task_id=1,
            conf_threshold=0.25,
            iou_threshold=0.5,
            per_class_conf_dict=None,
            save_selection="all",
            selected_class_ids=None,
            selected_cells=None,
        )

    seg = coco_output["annotations"][0]["segmentation"]
    assert seg == [[1908.0, 516.0, 1908.0, 534.0, 1890.0, 552.0, 1884.0, 552.0]]
