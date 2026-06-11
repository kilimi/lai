#!/usr/bin/env bash
# Build slim compose-only distribution bundle for PyPI wheel and optional GitHub Release tarball.
# Usage: bash scripts/build_dist_bundle.sh [version]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(python3 -c 'import lai; print(lai.__version__)' 2>/dev/null || echo 0.1.0)}"
VERSION="${VERSION#v}"
# Keep bundle staging out of dist/ so twine upload dist/* does not pick up lai-dist-*.
BUNDLE_DIR="${ROOT}/build/release"
ARCHIVE="${BUNDLE_DIR}/lai-dist-${VERSION}.tar.gz"
STAGE="${BUNDLE_DIR}/lai-dist-${VERSION}"
EMBED="${ROOT}/lai/bundle"

REGISTRY="${LAI_REGISTRY:-docker.io}"
ORG="${LAI_DOCKERHUB_USER:-${LAI_GHCR_ORG:-luluray}}"
# Docker image tag is resolved at install/pull time (Docker Hub), not tied to PyPI VERSION.
DOCKER_TAG="${LAI_DOCKER_TAG:-latest}"
if [[ "$REGISTRY" == "docker.io" ]]; then
  IMAGE_PREFIX="docker.io/${ORG}"
else
  IMAGE_PREFIX="${REGISTRY}/${ORG}"
fi

populate_stage() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest/dockers/backend" "$dest/scripts" "$dest/licenses"

  cp "$ROOT/docker-compose.yml" "$dest/"
  cp "$ROOT/docker-compose.code-mount.yml" "$dest/"
  cp "$ROOT/dockers/docker-compose.yml" "$dest/dockers/"
  cp "$ROOT/dockers/docker-compose.code-mount.yml" "$dest/dockers/"
  cp "$ROOT/dockers/backend/docker-compose.yml" "$dest/dockers/backend/"
  # End-user bundle: no host test mount (path does not exist on PyPI installs).
  sed -i '/\.\.\/\.\.\/tests:\/tests:ro/d' "$dest/dockers/backend/docker-compose.yml" 2>/dev/null || \
    sed -i '' '/\.\.\/\.\.\/tests:\/tests:ro/d' "$dest/dockers/backend/docker-compose.yml"

  cp "$ROOT/scripts/install.sh" "$dest/scripts/"
  cp "$ROOT/scripts/write_registry_env.py" "$dest/scripts/"
  cp "$ROOT/LICENSE" "$dest/"
  [[ -f "$ROOT/NOTICE" ]] && cp "$ROOT/NOTICE" "$dest/"
  [[ -f "$ROOT/THIRD_PARTY_LICENSES.md" ]] && cp "$ROOT/THIRD_PARTY_LICENSES.md" "$dest/"
  if [[ -d "$ROOT/licenses" ]]; then
    cp "$ROOT/licenses/"*.txt "$dest/licenses/" 2>/dev/null || true
  fi

  cat > "$dest/.env.example" <<EOF
# LAI pull-only install — run: lai install-gui  or  lai install
LAI_DATA_DIR=\${HOME}/lai-data
WEB_PORT=8089
VITE_API_URL=SAME_ORIGIN
LAI_BIND_CODE=0
LAI_GPU_TIER=1
COMPOSE_PROJECT_NAME=lai
COMPOSE_FILE=docker-compose.yml
COMPOSE_PROFILES=gpu
LAI_AUTO_DOCKER_LATEST=1
# LAI_RELEASE_VERSION is filled by lai install / lai pull from Docker Hub (not PyPI version).
LAI_BACKEND_IMAGE=${IMAGE_PREFIX}/lai-backend:${DOCKER_TAG}
LAI_WORKER_GENERAL_IMAGE=${IMAGE_PREFIX}/lai-worker-general:${DOCKER_TAG}
LAI_WORKER_GPU_IMAGE=${IMAGE_PREFIX}/lai-worker-gpu:${DOCKER_TAG}
LAI_FRONTEND_IMAGE=${IMAGE_PREFIX}/lai-frontend:${DOCKER_TAG}
LAI_SAM_IMAGE=${IMAGE_PREFIX}/lai-sam:${DOCKER_TAG}
LAI_ULTRALYTICS_IMAGE=${IMAGE_PREFIX}/lai-ultralytics:${DOCKER_TAG}
LAI_MMYOLO_IMAGE=${IMAGE_PREFIX}/lai-mmyolo:${DOCKER_TAG}
SAM3_MODELS_HOST_PATH=\${HOME}/lai-data/sam3-models
SAM3_CHECKPOINT_FILENAME=sam3.pt
EOF
}

populate_stage "$STAGE"
populate_stage "$EMBED"

mkdir -p "$BUNDLE_DIR"
tar -czf "$ARCHIVE" -C "$BUNDLE_DIR" "lai-dist-${VERSION}"
echo "Created $ARCHIVE"
echo "Embedded wheel bundle at $EMBED"
