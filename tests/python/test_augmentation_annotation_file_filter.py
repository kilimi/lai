"""Regression tests for augmentation selected annotation-file filtering."""

from unittest.mock import MagicMock

from app.tasks.augmentation_tasks import (
    _apply_selected_annotation_file_filter,
    _build_dataset_selection_filters,
)


def test_build_dataset_selection_filters_parses_annotation_file_and_collection():
    metadata = {
        "annotation_file_configs": [
            {"dataset_id": 21, "annotation_file_id": "9133", "collection_id": "66"},
            {"dataset_id": 22, "annotation_file_id": None, "collection_id": None},
        ]
    }

    collection_filter, annotation_filter = _build_dataset_selection_filters(metadata)

    assert collection_filter[21] == 66
    assert annotation_filter[21] == "9133"
    assert collection_filter[22] is None
    assert annotation_filter[22] is None


def test_build_dataset_selection_filters_skips_invalid_dataset_ids():
    metadata = {
        "annotation_file_configs": [
            {"dataset_id": "bad", "annotation_file_id": "100", "collection_id": "2"},
            {"dataset_id": 30, "annotation_file_id": "100", "collection_id": "2"},
        ]
    }

    collection_filter, annotation_filter = _build_dataset_selection_filters(metadata)

    assert 30 in collection_filter
    assert 30 in annotation_filter
    assert len(collection_filter) == 1
    assert len(annotation_filter) == 1


def test_apply_selected_annotation_file_filter_adds_filter_when_selected():
    query = MagicMock()
    query.filter.return_value = query

    result = _apply_selected_annotation_file_filter(
        query,
        dataset_id=21,
        dataset_annotation_file_filter={21: "9133"},
    )

    assert result is query
    query.filter.assert_called_once()


def test_apply_selected_annotation_file_filter_is_noop_without_selection():
    query = MagicMock()

    result = _apply_selected_annotation_file_filter(
        query,
        dataset_id=21,
        dataset_annotation_file_filter={21: None},
    )

    assert result is query
    query.filter.assert_not_called()