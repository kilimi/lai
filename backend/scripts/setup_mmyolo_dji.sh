#!/usr/bin/env sh
set -eu

REPO_DIR="${MMYOLO_DJI_REPO_DIR:-/opt/mmyolo-dji}"
PATCH_FILE="${MMYOLO_DJI_PATCH_FILE:-/opt/dji_patch/0001-NEW-ai-inside-init.patch}"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[mmyolo-dji] Cloning MMYOLO repository..."
  git clone https://github.com/open-mmlab/mmyolo.git "$REPO_DIR"
fi

cd "$REPO_DIR"

echo "[mmyolo-dji] Checking out v0.6.0..."
git fetch --tags
git checkout tags/v0.6.0

if git show-ref --verify --quiet refs/heads/drone-model-training; then
  git switch drone-model-training
else
  git switch -c drone-model-training
fi

if [ ! -f "$PATCH_FILE" ]; then
  echo "[mmyolo-dji] ERROR: required patch file not found: $PATCH_FILE" >&2
  exit 1
fi

if git apply --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "[mmyolo-dji] Applying DJI patch: $PATCH_FILE"
  git apply "$PATCH_FILE"
elif git diff --quiet tags/v0.6.0; then
  echo "[mmyolo-dji] ERROR: DJI patch not applied and cannot be applied" >&2
  echo "[mmyolo-dji] git apply --check failed; repo matches v0.6.0 with no patch changes" >&2
  exit 1
else
  echo "[mmyolo-dji] DJI patch already applied (repo differs from v0.6.0)."
fi

echo "[mmyolo-dji] Installing MMYOLO (editable) from $REPO_DIR"
MMYOLO_PY="${MMYOLO_PYTHON:-/opt/conda/envs/mmyolo/bin/python}"
if [ ! -x "$MMYOLO_PY" ]; then
  echo "[mmyolo-dji] ERROR: MMYOLO_PYTHON not found: $MMYOLO_PY" >&2
  exit 1
fi
export MKL_SERVICE_FORCE_INTEL="${MKL_SERVICE_FORCE_INTEL:-1}"
export MKL_THREADING_LAYER="${MKL_THREADING_LAYER:-GNU}"
export MKL_INTERFACE_LAYER="${MKL_INTERFACE_LAYER:-GNU,LP64}"
export PYTHONNOUSERSITE=1
unset PYTHONPATH
export GLIBC_TUNABLES="${GLIBC_TUNABLES:-glibc.rtld.execstack=2}"
"$MMYOLO_PY" -m pip install --no-cache-dir --no-build-isolation -e "$REPO_DIR" \
  || "$MMYOLO_PY" -m pip install --no-cache-dir -e "$REPO_DIR"

PYTHONPATH="$REPO_DIR" "$MMYOLO_PY" -c "import mmyolo; print('mmyolo version loaded:', getattr(mmyolo, '__version__', 'unknown'))"
