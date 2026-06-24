"""Tests for dataset media byte loading."""
from pathlib import Path

from app.services.media_bytes import static_url_to_local_path


def test_static_url_to_local_path():
    path = static_url_to_local_path("/static/projects/1/2/images/foo.jpg")
    assert path == Path("/app/projects/1/2/images/foo.jpg")
