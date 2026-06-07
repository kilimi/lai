"""Runs on worker startup when /opt/lai is on sys.path (before task imports)."""
from __future__ import annotations

import sys

_LAI = "/opt/lai/lib/python3.10/site-packages"
_CONDA = "/opt/conda/lib/python3.10/site-packages"

if _LAI not in sys.path:
    sys.path.insert(0, _LAI)
while _CONDA in sys.path:
    sys.path.remove(_CONDA)
if _LAI in sys.path:
    sys.path.insert(sys.path.index(_LAI) + 1, _CONDA)
