"""Tests for shared dataset builder helpers."""
from pathlib import Path

from app.ml.dataset.builder import (
    generate_safe_output_filename,
    resolve_source_image_path,
)


def test_generate_safe_output_filename_training():
    assert generate_safe_output_filename("0001.jpg", 42) == "ds42_0001.jpg"


def test_generate_safe_output_filename_augmented():
    name = generate_safe_output_filename("img.png", 1, augmentation_index=0, method_suffix="flip")
    assert name == "aug_0_flip_ds1_img.png"


def test_resolve_source_image_path_static_url():
    class Img:
        url = "/static/projects/5/photo.jpg"
        file_name = "photo.jpg"

    p = resolve_source_image_path(Img(), dataset_id=5)
    assert p == Path("projects/5/photo.jpg")
