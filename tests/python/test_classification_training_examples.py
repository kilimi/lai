"""Tests for YOLO classification training preview mosaics."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.tasks.training_visualization import (  # noqa: E402
    create_classification_training_examples,
    draw_classification_label_on_image,
)


def test_draw_classification_label_on_image():
    img = np.zeros((120, 200, 3), dtype=np.uint8)
    out = draw_classification_label_on_image(img, "cat", (0, 128, 255))
    assert out.shape == img.shape
    assert not np.array_equal(out, img)


def test_create_classification_training_examples(tmp_path):
    dataset = tmp_path / "dataset"
    (dataset / "train" / "cat").mkdir(parents=True)
    (dataset / "train" / "dog").mkdir(parents=True)
    cat_img = dataset / "train" / "cat" / "a.jpg"
    dog_img = dataset / "train" / "dog" / "b.jpg"
    cv2.imwrite(str(cat_img), np.zeros((64, 64, 3), dtype=np.uint8))
    cv2.imwrite(str(dog_img), np.ones((64, 64, 3), dtype=np.uint8) * 200)

    out = tmp_path / "examples"
    create_classification_training_examples(
        dataset_dir=dataset,
        output_dir=out,
        class_names=["cat", "dog"],
        num_examples=4,
        grid_size=(2, 2),
    )
    assert (out / "train_batch.jpg").is_file()
