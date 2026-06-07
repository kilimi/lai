"""Task name → queue routing contract."""
from app.celery._config import KNOWN_TASK_QUEUES, TASK_ROUTES


def test_known_tasks_have_expected_queue():
    assert KNOWN_TASK_QUEUES["app.tasks.dataset_tasks.duplicate_dataset"] == "general"
    assert KNOWN_TASK_QUEUES["app.tasks.export_tasks.export_yolo_model"] == "gpu"
    assert KNOWN_TASK_QUEUES["app.tasks.training_tasks.train_mmyolo_model"] == "mmyolo"
    assert KNOWN_TASK_QUEUES["app.tasks.depth_estimation_tasks.generate_depth_maps"] == "general"
    assert KNOWN_TASK_QUEUES["app.tasks.preannotate_tasks.run_yolo_preannotate"] == "general"
    assert KNOWN_TASK_QUEUES["app.tasks.annotation_tasks.process_annotation_file"] == "general"


def test_task_routes_cover_known_tasks():
    for task_name, queue in KNOWN_TASK_QUEUES.items():
        module_wildcard = ".".join(task_name.split(".")[:-1]) + ".*"
        matched = (
            TASK_ROUTES.get(task_name)
            or TASK_ROUTES.get(module_wildcard)
        )
        assert matched is not None, f"No route for {task_name}"
        assert matched["queue"] == queue
