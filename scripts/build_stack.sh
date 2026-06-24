#!/usr/bin/env bash
# Build ML runtime images and application workers in dependency order.
# Replaces the old monolithic celery_worker service.
# Prefer: lai build   or   lai dev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NO_CACHE=()
for arg in "$@"; do
  case "$arg" in
    --no-cache|--force) NO_CACHE+=(--no-cache) ;;
  esac
done

echo "==> ML runtime images (compose profile: build)"
echo "    Required before backend — lai-mmyolo:local is not on Docker Hub."
docker compose --profile build build ultralytics_runtime mmyolo_runtime "${NO_CACHE[@]}"

echo "==> Backend API (copies MMYOLO stack from lai-mmyolo image)"
docker compose build backend "${NO_CACHE[@]}"

echo "==> Celery workers (split CPU / GPU)"
docker compose build worker-gpu worker-general "${NO_CACHE[@]}"

echo "==> Web UI + SAM service"
docker compose build web sam_service "${NO_CACHE[@]}"

echo "Done. Start with: lai up   or   lai dev   or   docker compose up -d"
