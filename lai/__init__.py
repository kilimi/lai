"""LAI: pip-installable CLI to run the Docker-based stack."""

try:
    import importlib.metadata as _im

    __version__ = _im.version("lai")
except Exception:
    __version__ = "0.1.0"
