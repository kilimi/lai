"""
Shared Celery broker settings and task routing for all worker profiles.
"""
from __future__ import annotations

import os
from datetime import timedelta

from kombu import Queue

REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")

GENERAL_INCLUDE = [
    "app.tasks.dataset_tasks",
    "app.tasks.augmentation_tasks",
    "app.tasks.backup_tasks",
    "app.tasks.task_monitoring",
    "app.tasks.annotation_tasks",
    "app.tasks.depth_estimation_tasks",
    "app.tasks.preannotate_tasks",
    "app.tasks.maintenance_tasks",
]

GPU_INCLUDE = [
    "app.tasks.yolo_training",
    "app.tasks.mmyolo_training",
    "app.tasks.rtdetr_training",
    "app.tasks.evaluation_tasks",
    "app.tasks.export_tasks",
    "app.tasks.auto_annotation_tasks",
    "app.tasks.task_monitoring_gpu",
]

TASK_ROUTES = {
    "app.tasks.dataset_tasks.*": {"queue": "general"},
    "app.tasks.augmentation_tasks.*": {"queue": "general"},
    "app.tasks.backup_tasks.*": {"queue": "general"},
    "app.tasks.task_monitoring.*": {"queue": "general"},
    "app.tasks.annotation_tasks.*": {"queue": "general"},
    "app.tasks.depth_estimation_tasks.*": {"queue": "general"},
    "app.tasks.preannotate_tasks.*": {"queue": "general"},
    "app.tasks.training_tasks.cleanup_old_tasks": {"queue": "general"},
    "app.tasks.task_monitoring.refresh_worker_gpu_status": {"queue": "gpu"},
    "app.tasks.yolo_training.*": {"queue": "gpu"},
    "app.tasks.training_tasks.train_yolo_model": {"queue": "gpu"},
    "app.tasks.training_tasks.train_rtdetr_model": {"queue": "gpu"},
    "app.tasks.evaluation_tasks.*": {"queue": "gpu"},
    "app.tasks.export_tasks.*": {"queue": "gpu"},
    "app.tasks.auto_annotation_tasks.*": {"queue": "gpu"},
    "app.tasks.mmyolo_training.*": {"queue": "mmyolo"},
    "app.tasks.training_tasks.train_mmyolo_model": {"queue": "mmyolo"},
    "app.tasks.evaluation_tasks.yolo_test_inference": {"queue": "gpu"},
    "app.tasks.evaluation_tasks.mmyolo_test_inference": {"queue": "mmyolo"},
}

BEAT_SCHEDULE = {
    "check-backup-schedule": {
        "task": "app.tasks.backup_tasks.run_automatic_backup",
        "schedule": timedelta(hours=1),
    },
    "auto-cancel-stale-tasks": {
        "task": "app.tasks.task_monitoring.auto_cancel_stale_tasks",
        "schedule": timedelta(minutes=30),
    },
}

# All queues used in the deployment (workers subscribe to subsets).
TASK_QUEUES = (
    Queue("general", routing_key="general"),
    Queue("gpu", routing_key="gpu"),
    Queue("mmyolo", routing_key="mmyolo"),
)

KNOWN_TASK_QUEUES = {
    "app.tasks.dataset_tasks.duplicate_dataset": "general",
    "app.tasks.augmentation_tasks.create_augmented_dataset": "general",
    "app.tasks.backup_tasks.run_automatic_backup": "general",
    "app.tasks.task_monitoring.auto_cancel_stale_tasks": "general",
    "app.tasks.task_monitoring.refresh_worker_gpu_status": "gpu",
    "app.tasks.annotation_tasks.process_annotation_file": "general",
    "app.tasks.annotation_tasks.merge_annotation_files": "general",
    "app.tasks.depth_estimation_tasks.generate_depth_maps": "general",
    "app.tasks.preannotate_tasks.run_yolo_preannotate": "general",
    "app.tasks.training_tasks.cleanup_old_tasks": "general",
    "app.tasks.training_tasks.train_yolo_model": "gpu",
    "app.tasks.training_tasks.train_rtdetr_model": "gpu",
    "app.tasks.evaluation_tasks.evaluate_model": "gpu",
    "app.tasks.export_tasks.export_yolo_model": "gpu",
    "app.tasks.auto_annotation_tasks.auto_annotate_yolo": "gpu",
    "app.tasks.training_tasks.train_mmyolo_model": "mmyolo",
    "app.tasks.evaluation_tasks.yolo_test_inference": "gpu",
    "app.tasks.evaluation_tasks.mmyolo_test_inference": "mmyolo",
}


def apply_common_config(app, *, enable_beat: bool = False) -> None:
    """Apply broker, routing, and worker defaults to a Celery app instance."""
    conf = {
        "broker_url": REDIS_URL,
        "result_backend": REDIS_URL,
        "task_serializer": "json",
        "accept_content": ["json"],
        "result_serializer": "json",
        "timezone": "UTC",
        "enable_utc": True,
        "worker_prefetch_multiplier": 1,
        "worker_max_tasks_per_child": 1,
        "task_default_queue": "general",
        "task_queues": TASK_QUEUES,
        "task_routes": TASK_ROUTES,
        "result_expires": 3600 * 24,
        "result_backend_transport_options": {"master_name": "mymaster"},
        "task_acks_late": True,
        "task_reject_on_worker_lost": True,
        "worker_log_format": "[%(asctime)s: %(levelname)s/%(processName)s] %(message)s",
        "worker_task_log_format": (
            "[%(asctime)s: %(levelname)s/%(processName)s] "
            "[%(task_name)s(%(task_id)s)] %(message)s"
        ),
    }
    if enable_beat:
        conf["beat_schedule"] = BEAT_SCHEDULE
    app.conf.update(conf)
