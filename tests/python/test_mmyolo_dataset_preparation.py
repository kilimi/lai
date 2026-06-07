"""
TDD tests for MMYOLO COCO-format dataset preparation.

prepare_mmyolo_dataset() converts DB annotation objects into COCO JSON files
that MMYolo/RTMDet consumes — this is different from the YOLO .txt format.

All tests use in-memory fakes; no real DB, no filesystem writes (except tmp).
"""
import json
import pytest
import sys
import tempfile
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


from app.ml.dataset import prepare_mmyolo_dataset


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_image(id, file_name, width=640, height=480, dataset_id=1, url=None):
    img = MagicMock()
    img.id = id
    img.file_name = file_name
    img.width = width
    img.height = height
    img.dataset_id = dataset_id
    img.url = url or f"/static/projects/{dataset_id}/images/{file_name}"
    img.collection = None
    return img


def _make_annotation(id, image_id, category_id, annotation_file_id,
                     bbox=None, segmentation=None,
                     bbox_x=None, bbox_y=None, bbox_width=None, bbox_height=None):
    ann = MagicMock()
    ann.id = id
    ann.image_id = image_id
    ann.category_id = category_id
    ann.annotation_file_id = annotation_file_id
    ann.bbox = bbox
    ann.segmentation = segmentation
    ann.bbox_x = bbox_x
    ann.bbox_y = bbox_y
    ann.bbox_width = bbox_width
    ann.bbox_height = bbox_height
    return ann


def _make_class(id, class_name, category_id, annotation_file_id):
    cls = MagicMock()
    cls.id = id
    cls.class_name = class_name
    cls.category_id = category_id
    cls.annotation_file_id = annotation_file_id
    return cls


def _filter_key(expr) -> Optional[str]:
    left = getattr(expr, "left", None)
    return getattr(left, "key", None) if left is not None else None


def _filter_value(expr):
    """Extract the Python literal from a SQLAlchemy binary expression (bind param aware)."""
    right = getattr(expr, "right", None)
    if right is None:
        return None
    for attr in ("effective_value", "value"):
        if hasattr(right, attr):
            val = getattr(right, attr)
            if val is not None:
                return val
    return right


def _eq(a, b) -> bool:
    """Loose equality for test ids (int 10 vs str '10')."""
    if a == b:
        return True
    try:
        return str(a) == str(b)
    except Exception:
        return False


class _MockAnnQuery:
    """Filter annotations by image_id / annotation_file_id like SQLAlchemy .filter()."""

    def __init__(self, annotations: list, default_af_id: str):
        self._all = annotations
        self._image_id = None
        self._af_id = default_af_id

    def filter(self, *args, **_kwargs):
        for arg in args:
            key = _filter_key(arg)
            if key == "image_id":
                self._image_id = _filter_value(arg)
            elif key == "annotation_file_id":
                self._af_id = _filter_value(arg)
        return self

    def all(self):
        out = self._all
        if self._image_id is not None:
            out = [a for a in out if _eq(a.image_id, self._image_id)]
        if self._af_id is not None:
            out = [a for a in out if _eq(a.annotation_file_id, self._af_id)]
        return out


class _MockClsQuery:
    def __init__(self, classes: list, default_af_id: str):
        self._all = classes
        self._category_id = None
        self._class_name = None
        self._af_id = default_af_id

    def filter(self, *args, **_kwargs):
        for arg in args:
            key = _filter_key(arg)
            if key == "category_id":
                self._category_id = _filter_value(arg)
            elif key == "class_name":
                self._class_name = _filter_value(arg)
            elif key == "annotation_file_id":
                self._af_id = _filter_value(arg)
        return self

    def first(self):
        for c in self._all:
            if self._af_id is not None and not _eq(c.annotation_file_id, self._af_id):
                continue
            if self._category_id is not None and not _eq(c.category_id, self._category_id):
                continue
            if self._class_name is not None and c.class_name != self._class_name:
                continue
            return c
        return None

    def all(self):
        out = self._all
        if self._af_id is not None:
            out = [c for c in out if _eq(c.annotation_file_id, self._af_id)]
        return out


def _make_db(images, annotations, classes, annotation_file_id):
    """Build a minimal mock DB that responds to the queries prepare_mmyolo_dataset makes."""
    db = MagicMock()

    def query_side_effect(model_class):
        model_name = getattr(model_class, "__name__", "")

        mock_q = MagicMock()

        if model_name == "Dataset":
            ds = MagicMock()
            ds.id = 1
            ds.name = "Test Dataset"
            mock_q.filter.return_value.first.return_value = ds

        elif model_name == "Image":
            mock_q.filter.return_value.all.return_value = images
            mock_q.filter.return_value.join.return_value.filter.return_value.all.return_value = images

        elif model_name == "Annotation":
            mock_q.filter.side_effect = lambda *a, **k: _MockAnnQuery(
                annotations, annotation_file_id
            ).filter(*a, **k)

        elif model_name == "AnnotationClass":
            mock_q.filter.side_effect = lambda *a, **k: _MockClsQuery(
                classes, annotation_file_id
            ).filter(*a, **k)

        elif model_name == "AnnotationFile":
            af = MagicMock()
            af.id = annotation_file_id
            mock_q.filter.return_value.first.return_value = af

        return mock_q

    db.query.side_effect = query_side_effect
    return db


# ── Detection (bbox) ─────────────────────────────────────────────────────────

class TestPrepareMMYOLODatasetDetect:
    def test_produces_coco_json_with_categories(self, tmp_path):
        images = [_make_image(1, "img1.jpg")]
        classes = [_make_class(1, "cat", category_id=0, annotation_file_id=10)]
        annotations = [_make_annotation(1, image_id=1, category_id=0,
                                        annotation_file_id=10,
                                        bbox=[10, 20, 100, 80])]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")

        assert "train_json" in result
        train_json_path = Path(result["train_json"])
        assert train_json_path.exists()

        data = json.loads(train_json_path.read_text())
        assert "categories" in data
        assert "images" in data
        assert "annotations" in data
        assert any(c["name"] == "cat" for c in data["categories"])

    def test_bbox_written_as_xywh(self, tmp_path):
        images = [_make_image(1, "img1.jpg", width=640, height=480)]
        classes = [_make_class(1, "dog", category_id=0, annotation_file_id=10)]
        annotations = [_make_annotation(1, image_id=1, category_id=0,
                                        annotation_file_id=10,
                                        bbox=[50, 60, 200, 150])]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")

        data = json.loads(Path(result["train_json"]).read_text())
        assert len(data["annotations"]) == 1
        ann = data["annotations"][0]
        # COCO bbox: [x, y, width, height] — stored as-is from DB
        assert ann["bbox"] == [50, 60, 200, 150]

    def test_eighty_twenty_split_includes_all_images(self, tmp_path):
        """12 images at 80/20 must not drop the 12th (regression: was 9+2 only)."""
        images = [_make_image(i, f"img{i}.jpg") for i in range(1, 13)]
        classes = [_make_class(1, "car", category_id=0, annotation_file_id=10)]
        annotations = [
            _make_annotation(i, image_id=i, category_id=0, annotation_file_id=10, bbox=[0, 0, 10, 10])
            for i in range(1, 13)
        ]
        db = _make_db(images, annotations, classes, annotation_file_id=10)
        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 80, "val": 20, "test": 0},
        }]

        with patch("app.ml.dataset.formats.coco.copy_image_file"), patch(
            "app.ml.dataset.formats.coco.read_image_dimensions", return_value=(640, 480)
        ):
            result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")

        train_data = json.loads(Path(result["train_json"]).read_text())
        val_data = json.loads(Path(result["val_json"]).read_text())
        assert len(train_data["images"]) == 10
        assert len(val_data["images"]) == 2
        assert len(train_data["annotations"]) + len(val_data["annotations"]) == 12

    def test_class_count_in_result(self, tmp_path):
        images = [_make_image(1, "img1.jpg")]
        classes = [
            _make_class(1, "car", category_id=0, annotation_file_id=10),
            _make_class(2, "truck", category_id=1, annotation_file_id=10),
        ]
        anns = [
            _make_annotation(1, 1, 0, 10, bbox=[0, 0, 100, 100]),
            _make_annotation(2, 1, 1, 10, bbox=[100, 0, 100, 100]),
        ]
        db = _make_db(images, anns, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")
        assert result["class_count"] == 2
        assert set(result["class_names"]) == {"car", "truck"}


# ── Segmentation (polygon) ───────────────────────────────────────────────────

class TestPrepareMMYOLODatasetSegment:
    def test_segmentation_annotation_written(self, tmp_path):
        images = [_make_image(1, "img1.jpg", width=640, height=480)]
        classes = [_make_class(1, "person", category_id=0, annotation_file_id=10)]
        polygon = [10.0, 10.0, 50.0, 10.0, 50.0, 50.0, 10.0, 50.0]
        annotations = [_make_annotation(
            1, image_id=1, category_id=0, annotation_file_id=10,
            bbox=[10, 10, 40, 40], segmentation=[polygon],
        )]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="segment")

        data = json.loads(Path(result["train_json"]).read_text())
        ann = data["annotations"][0]
        assert "segmentation" in ann
        assert ann["segmentation"] != []

    def test_segment_task_requires_segmentation_data(self, tmp_path):
        """Dataset with only bbox annotations should raise for segment task."""
        images = [_make_image(1, "img1.jpg")]
        classes = [_make_class(1, "thing", category_id=0, annotation_file_id=10)]
        # No segmentation data — only bbox
        annotations = [_make_annotation(1, 1, 0, 10, bbox=[0, 0, 100, 100], segmentation=None)]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        with pytest.raises(ValueError, match="segmentation"):
            prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="segment")


# ── Oriented bounding boxes ──────────────────────────────────────────────────

class TestPrepareMMYOLODatasetOriented:
    def test_oriented_task_needs_segmentation_polygon_as_obb(self, tmp_path):
        """
        For oriented task, segmentation polygon (4-point) is used as the OBB.
        The output annotation must include a 'segmentation' key with 8 coords.
        """
        images = [_make_image(1, "img1.jpg", width=800, height=600)]
        classes = [_make_class(1, "plane", category_id=0, annotation_file_id=10)]
        # 4-point polygon (8 coords) representing an oriented box
        obb_polygon = [100.0, 50.0, 200.0, 60.0, 195.0, 120.0, 95.0, 110.0]
        annotations = [_make_annotation(
            1, image_id=1, category_id=0, annotation_file_id=10,
            bbox=[95, 50, 105, 70], segmentation=[obb_polygon],
        )]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="oriented")
        data = json.loads(Path(result["train_json"]).read_text())
        ann = data["annotations"][0]
        assert "segmentation" in ann
        # 8 coordinates for a 4-point oriented box
        assert len(ann["segmentation"][0]) == 8


# ── Train/val split ──────────────────────────────────────────────────────────

class TestPrepareMMYOLODatasetSplit:
    def test_val_json_created_when_split_nonzero(self, tmp_path):
        images = [_make_image(i, f"img{i}.jpg") for i in range(1, 6)]  # 5 images
        classes = [_make_class(1, "obj", category_id=0, annotation_file_id=10)]
        annotations = [_make_annotation(i, i, 0, 10, bbox=[0, 0, 10, 10]) for i in range(1, 6)]
        db = _make_db(images, annotations, classes, annotation_file_id=10)

        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 80, "val": 20, "test": 0},
        }]

        result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")

        assert "val_json" in result
        val_path = Path(result["val_json"])
        assert val_path.exists()

    def test_empty_dataset_raises(self, tmp_path):
        db = _make_db(images=[], annotations=[], classes=[], annotation_file_id=10)
        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 80, "val": 20, "test": 0},
        }]

        with pytest.raises(ValueError):
            prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")


class TestPrepareMMYOLODatasetSegmentFilter:
    def test_segment_accepts_polygon_without_stored_bbox(self, tmp_path):
        """RTMDet-Ins: mask-only rows should export (bbox derived from polygon)."""
        images = [_make_image(1, "img1.jpg", width=640, height=480)]
        classes = [_make_class(1, "car", category_id=0, annotation_file_id=10)]
        polygon = [64.0, 48.0, 320.0, 48.0, 320.0, 240.0, 64.0, 240.0]
        annotations = [_make_annotation(
            1, image_id=1, category_id=0, annotation_file_id=10,
            bbox=None, segmentation=[polygon],
            bbox_x=None, bbox_y=None, bbox_width=None, bbox_height=None,
        )]
        db = _make_db(images, annotations, classes, annotation_file_id=10)
        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        with patch("app.ml.dataset.formats.coco.copy_image_file"), patch(
            "app.ml.dataset.formats.coco.read_image_dimensions", return_value=(640, 480)
        ):
            result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="segment")

        data = json.loads(Path(result["train_json"]).read_text())
        assert len(data["images"]) == 1
        assert len(data["annotations"]) == 1
        assert data["annotations"][0]["segmentation"]
        assert data["annotations"][0]["bbox"][2] > 0

    def test_detect_with_normalized_bbox_columns(self, tmp_path):
        images = [_make_image(1, "img1.jpg", width=1000, height=800)]
        classes = [_make_class(1, "car", category_id=0, annotation_file_id=10)]
        annotations = [_make_annotation(
            1, image_id=1, category_id=0, annotation_file_id=10,
            bbox=None,
            bbox_x=0.1, bbox_y=0.2, bbox_width=0.3, bbox_height=0.4,
        )]
        db = _make_db(images, annotations, classes, annotation_file_id=10)
        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        with patch("app.ml.dataset.formats.coco.copy_image_file"), patch(
            "app.ml.dataset.formats.coco.read_image_dimensions", return_value=(1000, 800)
        ):
            result = prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="detect")

        data = json.loads(Path(result["train_json"]).read_text())
        ann = data["annotations"][0]
        assert ann["bbox"] == [100.0, 160.0, 300.0, 320.0]

    def test_bbox_only_dataset_rejected_for_segment(self, tmp_path):
        images = [_make_image(1, "img1.jpg")]
        classes = [_make_class(1, "car", category_id=0, annotation_file_id=10)]
        annotations = [_make_annotation(1, 1, 0, 10, bbox=[10, 10, 50, 50], segmentation=None)]
        db = _make_db(images, annotations, classes, annotation_file_id=10)
        dataset_configs = [{
            "dataset_id": 1,
            "annotation_file_id": 10,
            "split": {"train": 100, "val": 0, "test": 0},
        }]

        with pytest.raises(ValueError, match="segment"):
            prepare_mmyolo_dataset(db, dataset_configs, tmp_path, task="segment")
