"""Tests for default RGB image collection on new datasets."""
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
from app.routers import datasets as datasets_router  # noqa: E402
from app.services.dataset_collections_service import DEFAULT_IMAGE_COLLECTION_NAME  # noqa: E402


@pytest.fixture()
def datasets_client(tmp_path, monkeypatch):
    db_path = tmp_path / "default_collection.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    monkeypatch.chdir(tmp_path)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(datasets_router.router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as client:
        yield client, Session


def test_create_dataset_adds_default_rgb_collection(datasets_client):
    client, Session = datasets_client

    project = models.Project(name="P", description="")
    with Session() as db:
        db.add(project)
        db.commit()
        db.refresh(project)
        project_id = project.id

    response = client.post(
        "/datasets/",
        data={
            "name": "My Dataset",
            "description": "Test",
            "project_id": str(project_id),
            "tags": "[]",
        },
    )
    assert response.status_code == 200, response.text
    dataset_id = response.json()["id"]

    with Session() as db:
        collections = (
            db.query(models.ImageCollection)
            .filter(models.ImageCollection.dataset_id == dataset_id)
            .all()
        )
        assert len(collections) == 1
        assert collections[0].name == DEFAULT_IMAGE_COLLECTION_NAME
        assert collections[0].is_default is True
        assert collections[0].position == 0
