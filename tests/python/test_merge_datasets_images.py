"""Regression: merged datasets must resolve image paths like other dataset operations."""

from types import SimpleNamespace

from app.dataset_media_paths import resolve_dataset_image_path_from_models


def test_resolve_finds_image_in_collection_subdirectory(tmp_path, monkeypatch):
    project_id = 1
    dataset_id = 42
    collection_id = 5
    file_name = "sample.jpg"

    images_root = tmp_path / "projects" / str(project_id) / str(dataset_id) / "images"
    nested = images_root / f"c{collection_id}"
    nested.mkdir(parents=True)
    image_file = nested / file_name
    image_file.write_bytes(b"fake-image")

    monkeypatch.chdir(tmp_path)

    img = SimpleNamespace(
        file_name=file_name,
        url=f"/static/projects/{project_id}/{dataset_id}/images/c{collection_id}/{file_name}",
        collection_id=collection_id,
    )

    resolved = resolve_dataset_image_path_from_models(
        img,
        dataset_id=dataset_id,
        project_id=project_id,
    )

    assert resolved is not None
    assert resolved.resolve() == image_file.resolve()


def test_flat_projects_path_still_works(tmp_path, monkeypatch):
    project_id = 2
    dataset_id = 99
    file_name = "flat.png"

    flat_dir = tmp_path / "projects" / str(project_id) / str(dataset_id) / "images"
    flat_dir.mkdir(parents=True)
    image_file = flat_dir / file_name
    image_file.write_bytes(b"x")

    monkeypatch.chdir(tmp_path)

    img = SimpleNamespace(
        file_name=file_name,
        url=f"/static/projects/{project_id}/{dataset_id}/images/{file_name}",
        collection_id=None,
    )

    resolved = resolve_dataset_image_path_from_models(
        img,
        dataset_id=dataset_id,
        project_id=project_id,
    )

    assert resolved is not None
    assert resolved.name == file_name
