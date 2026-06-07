"""API tests for project CRUD routes."""
from __future__ import annotations

import sys
from pathlib import Path

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
from app.routers import projects as projects_router  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """SQLite in-memory app with projects router only."""
    db_path = tmp_path / "test.db"
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
    app.include_router(projects_router.router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as test_client:
        yield test_client, TestingSession


def test_create_and_list_projects(client):
    test_client, _ = client

    response = test_client.post(
        "/projects/",
        data={
            "name": "Test Project",
            "description": "Desc",
            "tags": '["alpha","beta"]',
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    project_id = body["data"]["id"]

    listed = test_client.get("/projects/")
    assert listed.status_code == 200
    projects = listed.json()
    assert len(projects) == 1
    assert projects[0]["name"] == "Test Project"
    assert projects[0]["id"] == project_id


def test_get_update_delete_project(client):
    test_client, Session = client

    created = test_client.post(
        "/projects/",
        data={"name": "Lifecycle", "description": "v1", "tags": "[]"},
    ).json()
    pid = created["data"]["id"]

    detail = test_client.get(f"/projects/{pid}")
    assert detail.status_code == 200
    assert detail.json()["name"] == "Lifecycle"

    updated = test_client.put(
        f"/projects/{pid}",
        data={"name": "Lifecycle v2", "description": "v2", "tags": '["x"]'},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Lifecycle v2"

    deleted = test_client.delete(f"/projects/{pid}")
    assert deleted.status_code == 200
    assert deleted.json()["success"] is True

    db = Session()
    assert db.query(models.Project).filter(models.Project.id == pid).first() is None
    db.close()


def test_duplicate_project(client):
    test_client, _ = client

    created = test_client.post(
        "/projects/",
        data={"name": "Original", "description": "d", "tags": '["t"]'},
    ).json()
    pid = created["data"]["id"]

    dup = test_client.post(f"/projects/{pid}/duplicate")
    assert dup.status_code == 200
    payload = dup.json()
    assert payload["success"] is True
    assert payload["data"]["name"] == "Original (Copy)"
    assert payload["data"]["id"] != pid


def test_projects_names_only(client):
    test_client, _ = client
    test_client.post(
        "/projects/",
        data={"name": "Names Only", "description": "", "tags": "[]"},
    )

    res = test_client.get("/projects/names-only")
    assert res.status_code == 200
    data = res.json()
    assert len(data) >= 1
    assert data[0]["name"] == "Names Only"
    assert "datasets" in data[0]


def test_delete_missing_project_returns_404(client):
    test_client, _ = client
    res = test_client.delete("/projects/99999")
    assert res.status_code == 404


def test_delete_project_with_dataset_and_image_collection(client):
    """Regression: bulk DELETE datasets left image_collections rows (FK violation)."""
    test_client, Session = client

    created = test_client.post(
        "/projects/",
        data={"name": "With Data", "description": "", "tags": "[]"},
    ).json()
    pid = created["data"]["id"]

    with Session() as db:
        dataset = models.Dataset(name="DS1", project_id=pid)
        db.add(dataset)
        db.flush()
        db.add(
            models.ImageCollection(
                dataset_id=dataset.id,
                name="RGB Images",
                is_default=True,
                position=0,
            )
        )
        db.commit()

    deleted = test_client.delete(f"/projects/{pid}")
    assert deleted.status_code == 200
    assert deleted.json()["success"] is True

    with Session() as db:
        assert db.query(models.Project).filter(models.Project.id == pid).first() is None
        assert (
            db.query(models.ImageCollection)
            .join(models.Dataset)
            .filter(models.Dataset.project_id == pid)
            .count()
            == 0
        )
