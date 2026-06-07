"""YOLO classification dataset export from image-level labels."""
from pathlib import Path
from types import SimpleNamespace

from app.ml.dataset.formats.yolo import (
    _is_classification_label_annotation,
    _prepare_yolo_classification_dataset,
)
from app.models import Annotation, AnnotationClass, Dataset, Image


def test_is_classification_label_annotation():
    cls_ann = SimpleNamespace(
        category_id=1,
        category="cat",
        bbox=None,
        bbox_x=None,
        bbox_width=None,
        bbox_height=None,
        segmentation=None,
    )
    det_ann = SimpleNamespace(
        category_id=1,
        category="cat",
        bbox=[10, 10, 20, 20],
        bbox_x=0.1,
        bbox_width=0.2,
        bbox_height=0.2,
        segmentation=None,
    )
    assert _is_classification_label_annotation(cls_ann) is True
    assert _is_classification_label_annotation(det_ann) is False


def test_prepare_classification_dataset(tmp_path, monkeypatch):
    img_path = tmp_path / "src" / "photo.jpg"
    img_path.parent.mkdir(parents=True)
    img_path.write_bytes(b"fake-image")

    image = SimpleNamespace(
        id=1,
        dataset_id=9,
        file_name="photo.jpg",
        url=f"/static/projects/9/photo.jpg",
        width=100,
        height=100,
    )
    ann = SimpleNamespace(
        image_id=1,
        annotation_file_id="af1",
        category_id=10,
        category="dog",
        bbox=None,
        bbox_x=None,
        bbox_y=None,
        bbox_width=None,
        bbox_height=None,
        segmentation=None,
    )
    ann_class = SimpleNamespace(
        annotation_file_id="af1",
        category_id=10,
        class_name="dog",
    )

    class FakeQuery:
        def __init__(self, items):
            self._items = items

        def filter(self, *args, **kwargs):
            return self

        def join(self, *args, **kwargs):
            return self

        def all(self):
            return self._items

        def first(self):
            return self._items[0] if self._items else None

    class FakeDB:
        def query(self, model):
            if model is AnnotationClass:
                return FakeQuery([ann_class])
            if model is Dataset:
                return FakeQuery([SimpleNamespace(id=9)])
            if model is Image:
                return FakeQuery([image])
            if model is Annotation:
                return FakeQuery([ann])
            return FakeQuery([])

    monkeypatch.setattr(
        "app.ml.dataset.formats.yolo.resolve_source_image_path",
        lambda image, dataset_id: img_path,
    )

    out = tmp_path / "dataset"
    result = _prepare_yolo_classification_dataset(
        FakeDB(),
        [
            {
                "dataset_id": 9,
                "annotation_file_id": "af1",
                "split": {"train": 100, "val": 0, "test": 0},
            }
        ],
        out,
    )

    assert result["dataset_format"] == "classify"
    assert result["class_names"] == ["dog"]
    dog_dir = out / "train" / "dog"
    assert dog_dir.is_dir()
    assert list(dog_dir.iterdir())
