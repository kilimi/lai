#!/bin/sh
# Celery GPU worker: use /opt/lai only. Do not put conda on PYTHONPATH (breaks Starlette/TypeIs).
set -eu

export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
export PYTHONPATH="/opt/lai/lib/python3.10/site-packages"
export PYTHONNOUSERSITE=1

exec /opt/conda/bin/python -m celery -A app.celery.gpu_app worker \
  -Q gpu,mmyolo -c 1 --pool=solo --loglevel=info "$@"
