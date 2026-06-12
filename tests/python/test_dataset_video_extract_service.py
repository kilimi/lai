"""Tests for video frame extraction service."""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app import models
from app.services.dataset_video_service import video_progress_get
from app.services.dataset_video_extract_service import extract_frames_from_video_service


def _mock_db(*, dataset=None, collection=None):
    db = MagicMock()
    query = MagicMock()
    db.query.return_value = query
    query.filter.return_value = query
    if dataset is not None:
        query.first.side_effect = [dataset, collection]
    else:
        query.first.return_value = None
    return db


def test_invalid_video_extension_sets_progress_error():
    job_id = "job-invalid-ext"
    db = _mock_db(
        dataset=SimpleNamespace(id=1, project_id=10, image_count=0),
        collection=SimpleNamespace(id=5, is_default=True),
    )
    upload = MagicMock()
    upload.filename = "clip.txt"
    upload.read = AsyncMock(side_effect=[b"", b""])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            extract_frames_from_video_service(
                db,
                1,
                upload,
                "http://localhost:9999",
                interval_seconds=1.0,
                frame_step=1,
                max_frames=0,
                job_id=job_id,
                collection_id=None,
                sequential_names=False,
                resize_width=0,
                resize_height=0,
            )
        )

    assert exc.value.status_code == 400
    progress = video_progress_get(job_id)
    assert progress is not None
    assert progress["stage"] == "error"
    assert "Invalid video file" in progress["error"]


def test_unopenable_video_sets_progress_error(tmp_path, monkeypatch):
    job_id = "job-bad-video"
    monkeypatch.chdir(tmp_path)
    (tmp_path / "projects").mkdir(parents=True)

    db = _mock_db(
        dataset=SimpleNamespace(id=2, project_id=20, image_count=0),
        collection=SimpleNamespace(id=7, is_default=True),
    )
    upload = MagicMock()
    upload.filename = "clip.mp4"
    upload.read = AsyncMock(side_effect=[b"not-a-real-mp4", b""])

    fake_cap = MagicMock()
    fake_cap.isOpened.return_value = False

    with patch("app.services.dataset_video_extract_service.cv2.VideoCapture", return_value=fake_cap):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                extract_frames_from_video_service(
                    db,
                    2,
                    upload,
                    "http://localhost:9999",
                    interval_seconds=1.0,
                    frame_step=1,
                    max_frames=0,
                    job_id=job_id,
                    collection_id=None,
                    sequential_names=False,
                    resize_width=0,
                    resize_height=0,
                )
            )

    assert exc.value.status_code == 400
    progress = video_progress_get(job_id)
    assert progress is not None
    assert progress["stage"] == "error"
    assert "Could not open video" in progress["error"]


def test_extract_frames_success_updates_progress(tmp_path, monkeypatch):
    job_id = "job-ok"
    monkeypatch.chdir(tmp_path)
    (tmp_path / "projects").mkdir(parents=True)

    db = _mock_db(
        dataset=SimpleNamespace(id=3, project_id=30, image_count=0),
        collection=SimpleNamespace(id=9, is_default=True),
    )

    def _add_image(obj):
        if isinstance(obj, models.Image):
            obj.uploaded_at = datetime.utcnow()
            obj.id = 100

    db.add.side_effect = _add_image
    upload = MagicMock()
    upload.filename = "clip.mp4"
    upload.read = AsyncMock(side_effect=[b"video-bytes", b""])

    import numpy as np

    frame = np.zeros((48, 64, 3), dtype=np.uint8)
    fake_cap = MagicMock()
    fake_cap.isOpened.return_value = True
    fake_cap.get.side_effect = lambda prop: {5: 25.0, 7: 2}.get(prop, 0)  # fps, frame count
    fake_cap.read.side_effect = [(True, frame), (True, frame), (False, None)]

    def _fake_imwrite(path, frame, params=None):
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"\xff\xd8\xff")
        return True

    with patch("app.services.dataset_video_extract_service.cv2.VideoCapture", return_value=fake_cap):
        with patch("app.services.dataset_video_extract_service.cv2.imwrite", side_effect=_fake_imwrite):
            with patch(
                "app.services.dataset_video_extract_service.set_random_image_as_logo",
                return_value=None,
            ):
                result = asyncio.run(
                    extract_frames_from_video_service(
                        db,
                        3,
                        upload,
                        "http://localhost:9999",
                        interval_seconds=1.0,
                        frame_step=1,
                        max_frames=0,
                        job_id=job_id,
                        collection_id=None,
                        sequential_names=False,
                        resize_width=0,
                        resize_height=0,
                    )
                )

    assert result["success"] is True
    assert result["data"]["uploaded"] == 1
    progress = video_progress_get(job_id)
    assert progress is not None
    assert progress["stage"] == "done"
    assert progress["percent"] == 100.0
