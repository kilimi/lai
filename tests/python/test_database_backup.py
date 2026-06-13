"""Round-trip tests for database export and import."""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

BACKEND_ROOT = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import Base, get_db  # noqa: E402
from app import models  # noqa: E402
from app.routers import database_backup as backup_router  # noqa: E402


def _clear_all_tables(session: Session) -> None:
    """Mirror import clear order for a clean slate."""
    for model in (
        models.DatasetGroup,
        models.Augmentation,
        models.Task,
        models.Annotation,
        models.AnnotationClass,
        models.AnnotationFile,
        models.Image,
        models.ImageCollection,
        models.Dataset,
        models.Project,
    ):
        session.query(model).delete()
    session.commit()


def _seed_sample_database(session: Session) -> dict[str, int | str]:
    """Minimal relational graph covering all backup tables."""
    project = models.Project(name="Export Project", description="for backup tests")
    session.add(project)
    session.flush()

    dataset = models.Dataset(name="Backup Dataset", project_id=project.id, image_count=1)
    session.add(dataset)
    session.flush()

    collection = models.ImageCollection(
        dataset_id=dataset.id,
        name="RGB Images",
        is_default=True,
        position=0,
    )
    session.add(collection)
    session.flush()

    image = models.Image(
        dataset_id=dataset.id,
        collection_id=collection.id,
        file_name="sample.jpg",
        file_size=1024,
        width=640,
        height=480,
        url="data/1/sample.jpg",
        thumbnail_url="data/1/sample_thumb.jpg",
    )
    session.add(image)
    session.flush()

    ann_file = models.AnnotationFile(
        id="backup-ann-1",
        dataset_id=dataset.id,
        name="instances.json",
        format="COCO",
        type="detection",
        annotation_count=1,
        image_count=1,
        category_count=1,
        is_processed=True,
        processing_status="completed",
    )
    session.add(ann_file)
    session.flush()

    ann_class = models.AnnotationClass(
        annotation_file_id=ann_file.id,
        class_name="person",
        color="#ff0000",
    )
    session.add(ann_class)
    session.flush()

    annotation = models.Annotation(
        annotation_file_id=ann_file.id,
        image_id=image.id,
        dataset_id=dataset.id,
        category="person",
        bbox_x=0.1,
        bbox_y=0.2,
        bbox_width=0.3,
        bbox_height=0.4,
        bbox=[0.1, 0.2, 0.3, 0.4],
        area=0.12,
        confidence=0.99,
    )
    session.add(annotation)

    task = models.Task(
        name="YOLO run",
        task_type="training",
        status="completed",
        project_id=project.id,
        progress=100.0,
        task_metadata={"epochs": 5, "model_type": "yolo11n.pt"},
    )
    session.add(task)
    session.flush()

    augmentation = models.Augmentation(
        task_id=task.id,
        source_dataset_ids=[dataset.id],
        target_dataset_id=dataset.id,
        augmentation_methods=["flip_horizontal"],
        method_parameters={"flip_horizontal": {}},
    )
    session.add(augmentation)

    group = models.DatasetGroup(
        name="Backup Group",
        project_id=project.id,
        dataset_ids=[dataset.id],
    )
    session.add(group)
    session.commit()

    return {
        "project_id": project.id,
        "dataset_id": dataset.id,
        "image_id": image.id,
        "annotation_file_id": ann_file.id,
        "task_id": task.id,
    }


@pytest.fixture()
def backup_client(tmp_path, monkeypatch):
    """Isolated SQLite app with database backup routes."""
    db_path = tmp_path / "backup_test.db"
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

    with TestClient(app) as test_client:
        yield test_client, TestingSession


def _load_export_json(response) -> dict:
    assert response.status_code == 200, response.text
    raw = response.content
    assert raw.strip().endswith(b"}}"), "streaming export should produce complete JSON"
    return json.loads(raw.decode("utf-8"))


def test_streaming_export_returns_valid_json(backup_client):
    test_client, Session = backup_client
    with Session() as db:
        _seed_sample_database(db)

    payload = _load_export_json(test_client.get("/database/export"))

    assert "metadata" in payload
    assert "data" in payload
    data = payload["data"]
    assert len(data["projects"]) == 1
    assert data["projects"][0]["name"] == "Export Project"
    assert len(data["datasets"]) == 1
    assert len(data["images"]) == 1
    assert len(data["annotations"]) == 1
    assert len(data["tasks"]) == 1
    assert len(data["augmentations"]) == 1
    assert len(data["dataset_groups"]) == 1


def test_json_export_import_roundtrip(backup_client):
    test_client, Session = backup_client
    with Session() as db:
        ids = _seed_sample_database(db)

    export_payload = _load_export_json(test_client.get("/database/export"))
    export_bytes = json.dumps(export_payload).encode("utf-8")

    with Session() as db:
        db.add(models.Project(name="Noise Project"))
        db.commit()
        assert db.query(models.Project).count() == 2

    import_response = test_client.post(
        "/database/import",
        files={"file": ("roundtrip.json", export_bytes, "application/json")},
    )
    assert import_response.status_code == 200, import_response.text
    body = import_response.json()
    assert "imported successfully" in body["message"].lower()
    assert "projects" in body["tables_imported"]

    with Session() as db:
        projects = db.query(models.Project).all()
        assert len(projects) == 1
        assert projects[0].name == "Export Project"

        dataset = db.query(models.Dataset).filter(models.Dataset.id == ids["dataset_id"]).one()
        assert dataset.name == "Backup Dataset"

        assert db.query(models.Image).count() == 1
        assert db.query(models.Annotation).count() == 1
        assert db.query(models.AnnotationFile).count() == 1
        assert db.query(models.Task).count() == 1
        assert db.query(models.Augmentation).count() == 1
        assert db.query(models.DatasetGroup).count() == 1

        task = db.query(models.Task).filter(models.Task.id == ids["task_id"]).one()
        assert task.task_metadata == {"epochs": 5, "model_type": "yolo11n.pt"}


def test_zip_export_import_roundtrip(backup_client, tmp_path):
    test_client, Session = backup_client
    with Session() as db:
        _seed_sample_database(db)

    data_dir = tmp_path / "data" / "1"
    data_dir.mkdir(parents=True)
    sample_file = data_dir / "sample.jpg"
    sample_file.write_bytes(b"fake-image-bytes")

    zip_response = test_client.get("/database/export-with-files")
    assert zip_response.status_code == 200, zip_response.text
    assert zip_response.headers["content-type"] == "application/zip"

    zip_bytes = zip_response.content
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        names = zf.namelist()
        assert "database.json" in names
        db_json = json.loads(zf.read("database.json").decode("utf-8"))
        assert db_json["data"]["projects"][0]["name"] == "Export Project"
        assert any("data" in n and "sample.jpg" in n for n in names)

    with Session() as db:
        _clear_all_tables(db)
        assert db.query(models.Project).count() == 0

    if sample_file.exists():
        sample_file.unlink()

    import_response = test_client.post(
        "/database/import",
        files={"file": ("backup.zip", zip_bytes, "application/zip")},
    )
    assert import_response.status_code == 200, import_response.text

    with Session() as db:
        assert db.query(models.Project).count() == 1
        assert db.query(models.Dataset).count() == 1

    assert sample_file.exists()
    assert sample_file.read_bytes() == b"fake-image-bytes"


def test_import_rejects_invalid_json(backup_client):
    test_client, _ = backup_client
    bad = b'{"metadata":{},"data":{"projects":[{"id":1,'

    response = test_client.post(
        "/database/import",
        files={"file": ("broken.json", bad, "application/json")},
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Invalid backup JSON" in detail


def test_import_rejects_missing_data_wrapper(backup_client):
    test_client, _ = backup_client
    payload = json.dumps({"metadata": {"version": "1.0"}}).encode("utf-8")

    response = test_client.post(
        "/database/import",
        files={"file": ("no-data.json", payload, "application/json")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid backup file format"


def test_serialize_model_replaces_nan_with_null():
    from app.routers.database_backup import serialize_model

    annotation = models.Annotation(
        image_id=1,
        dataset_id=1,
        category="person",
        confidence=float("nan"),
        area=float("inf"),
    )
    out = serialize_model(annotation)
    assert out["confidence"] is None
    assert out["area"] is None


def test_parse_backup_json_raises_http_exception_on_truncated_json():
    from fastapi import HTTPException
    from app.routers.database_backup import _parse_backup_json

    with pytest.raises(HTTPException) as exc:
        _parse_backup_json(b'{"data":{"projects":[{', source="test.json")
    assert exc.value.status_code == 400
    assert "Invalid backup JSON" in exc.value.detail


def test_import_rejects_zip_without_database_json(backup_client):
    test_client, _ = backup_client
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "not a backup")
    buf.seek(0)

    response = test_client.post(
        "/database/import",
        files={"file": ("bad.zip", buf.getvalue(), "application/zip")},
    )
    assert response.status_code == 400
    assert "database.json" in response.json()["detail"]


def _patch_export_task_env(monkeypatch, tmp_path, Session):
    """Run exports inline against the test DB and write files under tmp_path."""
    from app import task_dispatch
    from app.services import database_export_service

    monkeypatch.setattr(task_dispatch, "ALLOW_INLINE_TASKS", True)
    monkeypatch.setattr(
        "app.routers.database_backup.use_celery_enabled",
        lambda: False,
    )
    monkeypatch.setattr(database_export_service, "EXPORTS_ROOT", tmp_path / "exports")
    monkeypatch.setattr(database_export_service, "SessionLocal", Session)


def test_task_export_json_download(backup_client, tmp_path, monkeypatch):
    test_client, Session = backup_client
    _patch_export_task_env(monkeypatch, tmp_path, Session)

    with Session() as db:
        _seed_sample_database(db)

    start = test_client.post(
        "/database/export/start",
        json={"include_files": False},
    )
    assert start.status_code == 200, start.text
    body = start.json()
    assert body["success"] is True
    task_id = body["task_id"]

    download = test_client.get(f"/database/export/download/{task_id}")
    assert download.status_code == 200, download.text
    assert download.headers["content-type"] == "application/json"
    payload = json.loads(download.content.decode("utf-8"))
    assert payload["data"]["projects"][0]["name"] == "Export Project"


def test_task_export_zip_download(backup_client, tmp_path, monkeypatch):
    test_client, Session = backup_client
    _patch_export_task_env(monkeypatch, tmp_path, Session)

    with Session() as db:
        _seed_sample_database(db)

    data_dir = tmp_path / "data" / "1"
    data_dir.mkdir(parents=True)
    sample_file = data_dir / "sample.jpg"
    sample_file.write_bytes(b"fake-image-bytes")

    start = test_client.post(
        "/database/export/start",
        json={"include_files": True},
    )
    assert start.status_code == 200, start.text
    task_id = start.json()["task_id"]

    download = test_client.get(f"/database/export/download/{task_id}")
    assert download.status_code == 200, download.text
    assert download.headers["content-type"] == "application/zip"

    with zipfile.ZipFile(io.BytesIO(download.content), "r") as zf:
        assert "database.json" in zf.namelist()
        db_json = json.loads(zf.read("database.json").decode("utf-8"))
        assert db_json["data"]["projects"][0]["name"] == "Export Project"
