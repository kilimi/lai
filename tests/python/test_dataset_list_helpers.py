"""Unit tests for dataset_list_helpers thumbnail URL logic."""

from app.dataset_list_helpers import (
    MAX_LIST_VIEW_DATA_URL_CHARS,
    append_thumb_query_if_relative,
    resolve_dataset_list_thumbnail,
)


def test_append_thumb_adds_query():
    assert append_thumb_query_if_relative("/static/projects/1/2/images/a.jpg") == (
        "/static/projects/1/2/images/a.jpg?thumb=300"
    )


def test_append_thumb_preserves_existing():
    u = "/static/p/1.jpg?thumb=300"
    assert append_thumb_query_if_relative(u) is u


def test_append_thumb_appends_with_existing_query():
    assert append_thumb_query_if_relative("/x/y.png?v=1") == "/x/y.png?v=1&thumb=300"


def test_append_thumb_leaves_data_url():
    d = "data:image/jpeg;base64,abc"
    assert append_thumb_query_if_relative(d) is d


def test_resolve_drops_huge_data_url_uses_preview():
    huge = "data:image/jpeg;base64," + ("x" * (MAX_LIST_VIEW_DATA_URL_CHARS + 1))
    prev = "/static/projects/1/1/images/z.jpg?thumb=300"
    assert (
        resolve_dataset_list_thumbnail(
            huge,
            prev,
            include_base64_thumbnails=True,
        )
        == prev
    )


def test_resolve_keeps_small_data_url_when_allowed():
    small = "data:image/jpeg;base64,QQ=="
    prev = "/static/projects/1/1/images/z.jpg?thumb=300"
    assert (
        resolve_dataset_list_thumbnail(
            small,
            prev,
            include_base64_thumbnails=True,
        )
        == small
    )


def test_resolve_relative_stored_without_thumb():
    assert (
        resolve_dataset_list_thumbnail(
            "/static/projects/1/2/images/photo.jpg",
            None,
            include_base64_thumbnails=False,
        )
        == "/static/projects/1/2/images/photo.jpg?thumb=300"
    )