import pytest
from fastapi import HTTPException

from app.services.annotation_processing import (
    annotation_merge_group,
    normalize_annotation_merge_type,
    validate_annotation_files_merge_compatible,
)


def test_normalize_annotation_merge_type_legacy_aliases():
    assert normalize_annotation_merge_type("detection") == "Segmentation (bbox)"
    assert normalize_annotation_merge_type("segmentation-mask") == "Segmentation (mask)"


def test_annotation_merge_group_masks_unified():
    assert annotation_merge_group("Segmentation (mask)") == "mask"
    assert annotation_merge_group("Segmentation (mask+bbox)") == "mask"
    assert annotation_merge_group("Segmentation (bbox)") == "bbox"


def test_validate_merge_compatible_same_bbox_group():
    validate_annotation_files_merge_compatible(
        ["Segmentation (bbox)", "detection", "Segmentation (bbox)"]
    )


def test_validate_merge_allows_mask_with_mask_bbox():
    validate_annotation_files_merge_compatible(
        ["Segmentation (mask)", "Segmentation (mask+bbox)"]
    )


def test_validate_merge_rejects_bbox_with_mask():
    with pytest.raises(HTTPException) as exc:
        validate_annotation_files_merge_compatible(
            ["Segmentation (bbox)", "Segmentation (mask)"]
        )
    assert exc.value.status_code == 400
    assert "same type" in exc.value.detail.lower()


def test_validate_merge_rejects_other():
    with pytest.raises(HTTPException) as exc:
        validate_annotation_files_merge_compatible(["Other", "Segmentation (bbox)"])
    assert exc.value.status_code == 400
