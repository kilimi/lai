"""Register all model backends."""
from app.ml.backends.mmyolo import MMYOLOBackend
from app.ml.backends.ultralytics import UltralyticsRTDETRBackend, UltralyticsYoloBackend
from app.ml.registry import register_backend


def register_all_backends() -> None:
    """Idempotent registration of built-in backends."""
    register_backend(UltralyticsYoloBackend())
    register_backend(UltralyticsRTDETRBackend())
    register_backend(MMYOLOBackend())


register_all_backends()
