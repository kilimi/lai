import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import models
from app.services.dataset_annotation_merge_service import merge_annotation_files_task


class FakeQuery:
    def __init__(self, items):
        self._items = list(items)
        self._offset = 0
        self._limit = None

    def filter(self, *args, **kwargs):
        return self

    def offset(self, value):
        self._offset = value
        return self

    def limit(self, value):
        self._limit = value
        return self

    def first(self):
        items = self.all()
        return items[0] if items else None

    def all(self):
        items = self._items[self._offset :]
        if self._limit is not None:
            items = items[: self._limit]
        return items


class FakeSession:
    def __init__(self, task, annotation_files, images, class_batches, annotation_batches):
        self.task = task
        self.annotation_files = list(annotation_files)
        self.images = list(images)
        self.class_batches = list(class_batches)
        self.annotation_batches = list(annotation_batches)
        self.added_objects = []

    def query(self, model):
        if model is models.Task:
            return FakeQuery([self.task])
        if model is models.AnnotationFile:
            return FakeQuery(self.annotation_files)
        if model is models.Image:
            return FakeQuery(self.images)
        if model is models.AnnotationClass:
            batch = self.class_batches.pop(0)
            return FakeQuery(batch)
        if model is models.Annotation:
            batch = self.annotation_batches.pop(0)
            return FakeQuery(batch)
        raise AssertionError(f"Unexpected model queried: {model}")

    def add(self, obj):
        self.added_objects.append(obj)

    def commit(self):
        return None

    def refresh(self, obj):
        return None

    def close(self):
        return None


def test_merge_annotations_exact_strategy_removes_duplicates_and_preserves_unique_results():
    task = SimpleNamespace(
        id=99,
        status="pending",
        started_at=None,
        completed_at=None,
        progress=0,
        error_message=None,
        task_metadata={},
    )

    annotation_files = [
        SimpleNamespace(id="file_a", dataset_id=7, name="A", annotation_count=1),
        SimpleNamespace(id="file_b", dataset_id=7, name="B", annotation_count=2),
    ]
    images = [
        SimpleNamespace(id=101, dataset_id=7, width=100, height=100, file_name="img1.jpg"),
    ]
    class_batches = [
        [SimpleNamespace(class_name="cat")],
        [SimpleNamespace(class_name="cat"), SimpleNamespace(class_name="dog")],
    ]
    annotation_batches = [
        [
            SimpleNamespace(
                image_id=101,
                category="cat",
                bbox=[10, 10, 20, 20],
                area=400,
                segmentation=None,
            )
        ],
        [
            SimpleNamespace(
                image_id=101,
                category="cat",
                bbox=[10, 10, 20, 20],
                area=400,
                segmentation=None,
            ),
            SimpleNamespace(
                image_id=101,
                category="dog",
                bbox=[50, 50, 10, 10],
                area=100,
                segmentation=None,
            ),
        ],
    ]
    fake_db = FakeSession(task, annotation_files, images, class_batches, annotation_batches)
    process_coco = AsyncMock()

    with patch(
        "app.services.dataset_annotation_merge_service.SessionLocal", return_value=fake_db
    ), patch(
        "app.services.annotation_processing.detect_annotation_type", return_value="bbox"
    ), patch(
        "app.services.annotation_processing.process_coco_annotation_file", process_coco
    ):
        asyncio.run(
            merge_annotation_files_task(
                task_id=99,
                dataset_id=7,
                file_ids=["file_a", "file_b"],
                merged_filename="merged.json",
            )
        )

    assert task.status == "completed"
    assert task.task_metadata["duplicates_removed"] == 1
    assert task.task_metadata["total_annotations"] == 2

    merged_payload = process_coco.await_args.args[1]
    assert merged_payload["info"]["merge_strategy"] == "exact"
    assert merged_payload["info"]["merge_removed_exact"] == 1
    assert len(merged_payload["images"]) == 1
    assert {cat["name"] for cat in merged_payload["categories"]} == {"cat", "dog"}
    assert len(merged_payload["annotations"]) == 2
    assert {ann["category_id"] for ann in merged_payload["annotations"]} == {1, 2}

    added_file = fake_db.added_objects[0]
    assert added_file.name == "merged.json"
    assert added_file.annotation_count == 2
    assert added_file.image_count == 1
    assert added_file.category_count == 2


def test_merge_annotations_computes_area_for_segmentation_only_annotations():
    task = SimpleNamespace(
        id=100,
        status="pending",
        started_at=None,
        completed_at=None,
        progress=0,
        error_message=None,
        task_metadata={},
    )

    annotation_files = [
        SimpleNamespace(id="file_a", dataset_id=8, name="A", annotation_count=1),
        SimpleNamespace(id="file_b", dataset_id=8, name="B", annotation_count=1),
    ]
    images = [
        SimpleNamespace(id=201, dataset_id=8, width=100, height=100, file_name="img1.jpg"),
        SimpleNamespace(id=202, dataset_id=8, width=100, height=100, file_name="img2.jpg"),
    ]
    class_batches = [
        [SimpleNamespace(class_name="cat")],
        [SimpleNamespace(class_name="dog")],
    ]
    # Segmentation polygons are normalized, bbox/area are absent/zero.
    annotation_batches = [
        [
            SimpleNamespace(
                image_id=201,
                category="cat",
                bbox=None,
                bbox_x=None,
                bbox_y=None,
                bbox_width=None,
                bbox_height=None,
                area=0,
                segmentation=[[0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3]],
            )
        ],
        [
            SimpleNamespace(
                image_id=202,
                category="dog",
                bbox=None,
                bbox_x=None,
                bbox_y=None,
                bbox_width=None,
                bbox_height=None,
                area=0,
                segmentation=[[0.5, 0.5, 0.7, 0.5, 0.7, 0.7, 0.5, 0.7]],
            )
        ],
    ]
    fake_db = FakeSession(task, annotation_files, images, class_batches, annotation_batches)
    process_coco = AsyncMock()

    with patch(
        "app.services.dataset_annotation_merge_service.SessionLocal", return_value=fake_db
    ), patch(
        "app.services.annotation_processing.detect_annotation_type", return_value="segmentation"
    ), patch(
        "app.services.annotation_processing.process_coco_annotation_file", process_coco
    ):
        asyncio.run(
            merge_annotation_files_task(
                task_id=100,
                dataset_id=8,
                file_ids=["file_a", "file_b"],
                merged_filename="merged_seg.json",
            )
        )

    merged_payload = process_coco.await_args.args[1]
    assert len(merged_payload["annotations"]) == 2
    assert all(float(ann["area"]) > 0 for ann in merged_payload["annotations"])
    assert all(ann["bbox"][2] > 0 and ann["bbox"][3] > 0 for ann in merged_payload["annotations"])