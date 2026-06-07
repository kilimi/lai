"""Unit tests for annotation count resolution helpers."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.annotation_processing import resolve_annotation_count  # noqa: E402


@pytest.mark.parametrize(
    "stored,live,expected",
    [
        (24, 98, 98),
        (24, 0, 24),
        (None, 5, 5),
        (0, 0, 0),
    ],
)
def test_resolve_annotation_count(stored, live, expected):
    assert resolve_annotation_count(stored, live) == expected
