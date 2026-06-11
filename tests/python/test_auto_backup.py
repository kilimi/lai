"""Tests for automatic backup path resolution, service, and API routes."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import Base, get_db  # noqa: E402
from app import models  # noqa: E402
from app.routers import backup as backup_router  # noqa: E402
from app.services.backup_runner import (  # noqa: E402
    is_backup_configured,
    is_backup_path_configured,
    resolve_backup_paths,
    BackupResult,
    RestoreResult,
)
from app.services.backup_service import BackupService  # noqa: E402


@pytest.fixture()
def backup_api_client(tmp_path, monkeypatch):
    db_path = tmp_path / "auto_backup.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    monkeypatch.chdir(tmp_path)

    def override_get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(backup_router.router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as client:
        yield client, TestingSession


def _seed_backup_settings(session, *, enabled=True, backup_path=""):
    settings = models.BackupSettings(
        enabled=enabled,
        backup_path=backup_path,
        frequency_hours=24,
        retention_days=30,
    )
    session.add(settings)
    session.commit()
    session.refresh(settings)
    return settings


def _seed_backup_record(session, backup_path: str, status="completed"):
    record = models.BackupRecord(
        backup_path=backup_path,
        backup_type="full",
        status=status,
        database_backed_up=True,
        files_backed_up=True,
        started_at=datetime.utcnow(),
        completed_at=datetime.utcnow(),
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


class TestResolveBackupPaths:
    def test_empty_means_root(self):
        stored, container = resolve_backup_paths("")
        assert stored == ""
        assert container == "/app/backups"

    def test_dot_means_root(self):
        stored, container = resolve_backup_paths(".")
        assert stored == ""
        assert container == "/app/backups"

    def test_relative_subdirectory(self):
        stored, container = resolve_backup_paths("daily")
        assert stored == "daily"
        assert container == "/app/backups/daily"

    def test_absolute_under_app_backups(self):
        stored, container = resolve_backup_paths("/app/backups/custom")
        assert stored == "/app/backups/custom"
        assert container == "/app/backups/custom"


class TestBackupConfigured:
    def test_empty_path_is_configured(self):
        settings = models.BackupSettings(enabled=True, backup_path="")
        assert is_backup_path_configured(settings)
        assert is_backup_configured(settings)

    def test_none_path_not_configured(self):
        settings = models.BackupSettings(enabled=True, backup_path=None)
        assert not is_backup_path_configured(settings)

    def test_disabled_not_configured(self):
        settings = models.BackupSettings(enabled=False, backup_path="")
        assert not is_backup_configured(settings)


class TestBackupServiceIncremental:
    def test_create_incremental_backup_writes_manifest(self, tmp_path):
        source = tmp_path / "projects"
        source.mkdir()
        (source / "a.txt").write_text("hello")

        base = tmp_path / "backups"
        service = BackupService(str(base))
        backup_path, stats = service.create_incremental_backup(
            source, "backup_test", parent_backup_path=None
        )

        assert stats["total_files"] == 1
        assert (backup_path / "a.txt").read_text() == "hello"
        assert (backup_path / ".backup_manifest.json").exists()


class TestBackupServiceRestore:
    def _make_snapshot(self, tmp_path) -> Path:
        snapshot = tmp_path / "backup_20240101_120000"
        projects = snapshot / "1" / "images"
        projects.mkdir(parents=True)
        (projects / "img.jpg").write_bytes(b"image-data")

        db_dir = snapshot / "database"
        db_dir.mkdir()
        (db_dir / "database_test.dump").write_bytes(b"fake-dump")

        manifest = snapshot / ".backup_manifest.json"
        manifest.write_text(json.dumps({"1/images/img.jpg": {"size": 10}}))
        return snapshot

    def test_validate_snapshot(self, tmp_path):
        snapshot = self._make_snapshot(tmp_path)
        service = BackupService(str(tmp_path))
        info = service.validate_snapshot(snapshot)
        assert info["can_restore_database"]
        assert info["can_restore_files"]

    def test_restore_projects_renames_existing(self, tmp_path):
        snapshot = self._make_snapshot(tmp_path)
        target = tmp_path / "live_projects"
        target.mkdir()
        (target / "old.txt").write_text("old")

        service = BackupService(str(tmp_path))
        ok, rollback, err = service.restore_projects(snapshot, target)

        assert ok
        assert err is None
        assert rollback is not None
        assert Path(rollback).exists()
        assert (Path(rollback) / "old.txt").read_text() == "old"
        assert (target / "1" / "images" / "img.jpg").read_bytes() == b"image-data"

    @patch("app.services.backup_service.subprocess.run")
    def test_restore_database_calls_pg_restore(self, mock_run, tmp_path):
        snapshot = self._make_snapshot(tmp_path)
        mock_run.return_value = type("R", (), {"returncode": 0, "stderr": ""})()

        service = BackupService(str(tmp_path))
        ok, err = service.restore_database(
            snapshot, "postgresql://postgres:postgres@db:5432/lai_db"
        )

        assert ok
        assert err is None
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "pg_restore"


class TestBackupRouter:
    def test_run_backup_accepts_empty_path_when_enabled(self, backup_api_client):
        client, Session = backup_api_client
        with Session() as db:
            _seed_backup_settings(db, enabled=True, backup_path="")

        with patch("app.routers.backup.run_backup") as mock_run:
            mock_run.return_value = BackupResult(status="completed", backup_id=1)
            response = client.post("/backup/run")

        assert response.status_code == 200
        mock_run.assert_called_once()

    def test_run_backup_rejects_when_disabled(self, backup_api_client):
        client, Session = backup_api_client
        with Session() as db:
            _seed_backup_settings(db, enabled=False, backup_path="")

        response = client.post("/backup/run")
        assert response.status_code == 400

    def test_restore_requires_confirm_token(self, backup_api_client, tmp_path):
        client, Session = backup_api_client
        snapshot = tmp_path / "backup_test"
        snapshot.mkdir()
        with Session() as db:
            record = _seed_backup_record(db, str(snapshot))

        response = client.post(
            f"/backup/{record.id}/restore",
            json={
                "restore_database": True,
                "restore_files": True,
                "confirm": "WRONG",
            },
        )
        assert response.status_code == 400

    def test_restore_starts_with_valid_confirm(self, backup_api_client, tmp_path):
        client, Session = backup_api_client
        snapshot = tmp_path / "backup_test"
        snapshot.mkdir()
        with Session() as db:
            record = _seed_backup_record(db, str(snapshot))

        with patch("app.routers.backup.run_restore") as mock_restore:
            response = client.post(
                f"/backup/{record.id}/restore",
                json={
                    "restore_database": True,
                    "restore_files": False,
                    "confirm": "RESTORE",
                },
            )

        assert response.status_code == 200
        assert response.json()["success"] is True

    def test_list_backups_with_empty_path(self, backup_api_client, tmp_path, monkeypatch):
        client, Session = backup_api_client
        backup_root = tmp_path / "backups"
        backup_root.mkdir()

        with Session() as db:
            _seed_backup_settings(db, enabled=True, backup_path="")

        monkeypatch.setattr(
            backup_router,
            "resolve_backup_paths",
            lambda p: ("", str(backup_root)),
        )

        response = client.get("/backup/list")
        assert response.status_code == 200
        assert "backups" in response.json()

    def test_get_backup_detail(self, backup_api_client, tmp_path):
        client, Session = backup_api_client
        snapshot = tmp_path / "backup_detail"
        snapshot.mkdir()
        db_dir = snapshot / "database"
        db_dir.mkdir()
        (db_dir / "database_x.dump").write_bytes(b"dump")

        with Session() as db:
            record = _seed_backup_record(db, str(snapshot))

        response = client.get(f"/backup/{record.id}")
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == record.id
        assert body["can_restore"] is True
        assert body["can_restore_database"] is True
