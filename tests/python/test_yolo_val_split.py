"""YOLO dataset val split helpers (Ultralytics 8.4+ requires non-empty val source)."""
from pathlib import Path

from app.ml.dataset.formats.yolo import (
    _compute_split_sizes,
    _resolve_yolo_val_path,
    _split_dir_has_images,
)


def test_compute_split_sizes_reserves_val_for_tiny_datasets():
    train, val, test = _compute_split_sizes(4, {"train": 80, "val": 20, "test": 0})
    assert train + val + test == 4
    assert val >= 1
    assert train >= 1


def test_compute_split_sizes_single_image():
    train, val, test = _compute_split_sizes(1, {"train": 80, "val": 20, "test": 0})
    assert (train, val, test) == (1, 0, 0)


def test_write_yolo_data_yaml_names_use_integer_keys(tmp_path: Path):
    from app.ml.dataset.formats.yolo import _write_yolo_data_yaml

    yaml_path = tmp_path / "data.yaml"
    _write_yolo_data_yaml(
        yaml_path,
        abs_path=tmp_path,
        train="images/train",
        val="images/val",
        test=None,
        class_mapping={"car_bb": 0, "truck": 1},
        is_segmentation_model=False,
    )
    text = yaml_path.read_text()
    assert "  0: car_bb" in text
    assert "  1: truck" in text
    assert "car_bb:" not in text.split("names:")[1]


def test_resolve_yolo_val_path_falls_back_to_train(tmp_path: Path):
    images = tmp_path / "images"
    (images / "train").mkdir(parents=True)
    (images / "val").mkdir(parents=True)
    (images / "train" / "a.jpg").write_bytes(b"x")

    assert _resolve_yolo_val_path(tmp_path, total_val_count=0) == "images/train"


def test_resolve_yolo_val_path_uses_val_when_populated(tmp_path: Path):
    images = tmp_path / "images"
    (images / "train").mkdir(parents=True)
    (images / "val").mkdir(parents=True)
    (images / "val" / "b.jpg").write_bytes(b"x")

    assert _resolve_yolo_val_path(tmp_path, total_val_count=1) == "images/val"
    assert _split_dir_has_images(images / "val") is True
