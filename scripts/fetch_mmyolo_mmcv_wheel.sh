#!/usr/bin/env bash
# Download mmcv prebuilt wheel for Dockerfile.mmyolo.runtime (Python 3.8, cu113, torch 1.10).
# After this, mmyolo_runtime uses wheels/ offline and never compiles mmcv from source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/dockers/backend/wheels"
MMCV_VERSION="${MMCV_VERSION:-2.0.1}"
WHEEL="mmcv-${MMCV_VERSION}-cp38-cp38-manylinux1_x86_64.whl"
BASE="https://download.openmmlab.com/mmcv/dist/cu113/torch1.10.0"
URL="${BASE}/${WHEEL}"

mkdir -p "$DEST"
echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL "$URL" -o "$DEST/$WHEEL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$DEST/$WHEEL" "$URL"
else
  echo "Need curl or wget" >&2
  exit 1
fi
echo "Saved $DEST/$WHEEL"
echo "Rebuild: lai build  (mmyolo_runtime will install mmcv from wheels/)"
