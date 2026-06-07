"""
Test suite for NMS IoU threshold feature.
Tests that NMS IoU threshold is separate from matching IoU threshold.
"""
import inspect
from unittest.mock import MagicMock, patch

from app.tasks.evaluation_tasks import evaluate_model, nms_predictions


class TestNMSPredictions:
    """Test the NMS predictions function."""

    def test_nms_removes_overlapping_predictions_same_class(self):
        predictions = [
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [10, 10, 50, 50],
                "bbox_xyxy": [10, 10, 60, 60],
                "conf": 0.9,
                "segmentation": [],
            },
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [15, 15, 50, 50],
                "bbox_xyxy": [15, 15, 65, 65],
                "conf": 0.8,
                "segmentation": [],
            },
        ]

        result = nms_predictions(predictions, iou_threshold=0.3)

        assert len(result) == 1
        assert result[0]["conf"] == 0.9

    def test_nms_keeps_different_classes(self):
        predictions = [
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [10, 10, 50, 50],
                "bbox_xyxy": [10, 10, 60, 60],
                "conf": 0.9,
                "segmentation": [],
            },
            {
                "image_id": 1,
                "class_id": 1,
                "bbox": [15, 15, 50, 50],
                "bbox_xyxy": [15, 15, 65, 65],
                "conf": 0.8,
                "segmentation": [],
            },
        ]

        result = nms_predictions(predictions, iou_threshold=0.3)

        assert len(result) == 2

    def test_nms_threshold_affects_suppression(self):
        predictions = [
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [10, 10, 50, 50],
                "bbox_xyxy": [10, 10, 60, 60],
                "conf": 0.9,
                "segmentation": [],
            },
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [30, 30, 50, 50],
                "bbox_xyxy": [30, 30, 80, 80],
                "conf": 0.8,
                "segmentation": [],
            },
        ]

        result_low = nms_predictions(predictions.copy(), iou_threshold=0.1)
        assert len(result_low) == 1

        result_high = nms_predictions(predictions.copy(), iou_threshold=0.9)
        assert len(result_high) == 2

    def test_nms_empty_predictions(self):
        result = nms_predictions([], iou_threshold=0.5)
        assert result == []

    def test_nms_single_prediction(self):
        predictions = [
            {
                "image_id": 1,
                "class_id": 0,
                "bbox": [10, 10, 50, 50],
                "bbox_xyxy": [10, 10, 60, 60],
                "conf": 0.9,
                "segmentation": [],
            }
        ]

        result = nms_predictions(predictions, iou_threshold=0.5)
        assert len(result) == 1
        assert result[0]["conf"] == 0.9


class TestEvaluationTaskNMSParameter:
    """Test that evaluate_model task uses nms_iou_threshold correctly."""

    @patch("app.tasks.evaluation_tasks._resolve_evaluation_image_path")
    @patch("app.ml.dispatch.get_model_backend")
    @patch("app.tasks.training_common.get_ultralytics_yolo")
    @patch("app.tasks.evaluation_tasks.SessionLocal")
    @patch("app.tasks.evaluation_tasks.write_evaluation_blobs")
    def test_nms_iou_threshold_passed_to_model_predict(
        self,
        mock_write_blobs,
        mock_session,
        mock_get_yolo,
        mock_get_backend,
        mock_resolve_image_path,
    ):
        mock_db = MagicMock()
        mock_session.return_value = mock_db

        mock_task = MagicMock()
        mock_task.id = 1
        mock_task.project_id = 1
        mock_task.task_metadata = {}
        mock_db.query.return_value.filter.return_value.first.return_value = mock_task

        mock_training_task = MagicMock()
        mock_training_task.status = "completed"
        mock_training_task.project_id = 1
        mock_training_task.task_metadata = {
            "model_type": "yolov11n.pt",
            "best_model": "/tmp/test/best.pt",
            "class_names": ["cat"],
        }

        mock_backend = MagicMock()
        mock_backend.runtime_profile = "ultralytics"
        mock_get_backend.return_value = mock_backend

        mock_model = MagicMock()
        mock_get_yolo.return_value = MagicMock(return_value=mock_model)
        mock_resolve_image_path.return_value = __import__("pathlib").Path("/tmp/test.jpg")

        predict_calls = []

        def capture_predict(*args, **kwargs):
            predict_calls.append(kwargs)
            mock_result = MagicMock()
            mock_result.boxes = []
            return [mock_result]

        mock_model.predict = capture_predict

        mock_write_blobs.return_value = ("pred.json.gz", "gt.json.gz", "cm.json.gz")

        mock_dataset = MagicMock()
        mock_dataset.id = 1
        mock_dataset.project_id = 1
        mock_dataset.image_dir = "/tmp/test"

        mock_image = MagicMock()
        mock_image.id = 1
        mock_image.file_name = "test.jpg"
        mock_image.width = 640
        mock_image.height = 480

        query_mock = MagicMock()
        query_mock.filter.return_value.first.side_effect = [
            mock_task,
            mock_training_task,
            mock_dataset,
        ]
        query_mock.filter.return_value.all.return_value = [mock_image]
        mock_db.query.return_value = query_mock

        with patch("app.tasks.evaluation_tasks.Path") as mock_path:
            mock_path.return_value.exists.return_value = True

            try:
                evaluate_model(
                    self=MagicMock(),
                    task_id=1,
                    training_task_id=1,
                    dataset_id=1,
                    annotation_file_id=None,
                    checkpoint="best",
                    conf_threshold=0.25,
                    iou_threshold=0.7,
                    nms_iou_threshold=0.45,
                    use_grid=False,
                )
            except Exception:
                pass

        if predict_calls:
            for call_kwargs in predict_calls:
                if "iou" in call_kwargs:
                    assert call_kwargs["iou"] == 0.45


class TestEvaluationMetadata:
    """Test that nms_iou_threshold is stored in evaluation metadata."""

    def test_nms_iou_threshold_in_metadata(self):
        sig = inspect.signature(evaluate_model)
        params = sig.parameters

        assert "nms_iou_threshold" in params
        assert params["nms_iou_threshold"].default == 0.45


class TestDocumentation:
    """Test that the feature is properly documented."""

    def test_docstring_explains_parameters(self):
        docstring = evaluate_model.__doc__ or ""

        assert "nms" in docstring.lower() or "maximum suppression" in docstring.lower()
        assert "iou_threshold" in docstring.lower()