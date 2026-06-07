"""ORM-safe deletion helpers (bulk query.delete() bypasses SQLAlchemy cascades)."""
from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import models


def remove_dataset_from_groups(db: Session, dataset_id: int) -> None:
    """Remove a dataset id from every dataset group's membership list."""
    for group in db.query(models.DatasetGroup).all():
        if group.datasets_list and dataset_id in group.datasets_list:
            group.datasets_list = [gid for gid in group.datasets_list if gid != dataset_id]


def delete_augmentations_for_dataset(db: Session, dataset_id: int) -> None:
    for aug in db.query(models.Augmentation).filter(
        models.Augmentation.target_dataset_id == dataset_id
    ).all():
        db.delete(aug)
    for aug in db.query(models.Augmentation).all():
        if aug.source_dataset_ids and dataset_id in aug.source_dataset_ids:
            aug.source_dataset_ids = [
                sid for sid in aug.source_dataset_ids if sid != dataset_id
            ]


def delete_dataset_record(db: Session, dataset: models.Dataset) -> None:
    """Delete one dataset and dependent rows via ORM cascades."""
    remove_dataset_from_groups(db, dataset.id)
    delete_augmentations_for_dataset(db, dataset.id)
    db.delete(dataset)


def delete_project_record(db: Session, project_id: int) -> None:
    """Delete a project and all dependent database rows."""
    datasets = (
        db.query(models.Dataset)
        .filter(models.Dataset.project_id == project_id)
        .all()
    )
    dataset_ids = [ds.id for ds in datasets]

    task_ids = [
        row[0]
        for row in db.query(models.Task.id)
        .filter(models.Task.project_id == project_id)
        .all()
    ]

    aug_filters = []
    if task_ids:
        aug_filters.append(models.Augmentation.task_id.in_(task_ids))
    if dataset_ids:
        aug_filters.append(models.Augmentation.target_dataset_id.in_(dataset_ids))
    if aug_filters:
        db.query(models.Augmentation).filter(or_(*aug_filters)).delete(
            synchronize_session=False
        )

    db.query(models.Task).filter(models.Task.project_id == project_id).delete(
        synchronize_session=False
    )
    db.query(models.DatasetGroup).filter(
        models.DatasetGroup.project_id == project_id
    ).delete(synchronize_session=False)
    db.query(models.Pipeline).filter(models.Pipeline.project_id == project_id).delete(
        synchronize_session=False
    )

    for dataset in datasets:
        delete_dataset_record(db, dataset)

    project = db.query(models.Project).filter(models.Project.id == project_id).first()
    if project:
        db.delete(project)
