"""Ensure Celery worker imports resolve /opt/lai before conda site-packages."""
from __future__ import annotations

import sys

_LAI_SITE = "/opt/lai/lib/python3.10/site-packages"
_CONDA_SITE = "/opt/conda/lib/python3.10/site-packages"


def prefer_lai_site_packages() -> None:
    """
    Starlette/FastAPI in /opt/lai need typing_extensions.TypeIs (4.10+).

    Conda base may ship an older typing_extensions. Re-order sys.path so
    /opt/lai precedes conda site-packages when both are present.
    """
    if _LAI_SITE not in sys.path:
        sys.path.insert(0, _LAI_SITE)
    # Demote conda site below lai (keep it for tasks that call ensure_ultralytics_sys_path).
    while _CONDA_SITE in sys.path:
        sys.path.remove(_CONDA_SITE)
    if _LAI_SITE in sys.path:
        lai_idx = sys.path.index(_LAI_SITE)
        sys.path.insert(lai_idx + 1, _CONDA_SITE)
    else:
        sys.path.insert(0, _CONDA_SITE)
