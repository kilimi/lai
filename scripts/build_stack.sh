#!/usr/bin/env bash
# Build ML runtime images and application workers in dependency order.
# Replaces the old monolithic celery_worker service (see docs/WORKERS.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NO_CACHE=()
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE+=(--no-cache) ;;
  esac
done

echo "==> ML runtime images (compose profile: build)"
docker compose --profile build build ultralytics_runtime mmyolo_runtime "${NO_CACHE[@]}"

echo "==> Backend API (copies MMYOLO stack from lai-mmyolo image)"
docker compose build backend "${NO_CACHE[@]}"

echo "==> Celery workers (split CPU / GPU)"
docker compose build worker-gpu worker-general "${NO_CACHE[@]}"

echo "==> Optional: web + SAM (skip with Ctrl+C if not needed)"
docker compose build web sam_service "${NO_CACHE[@]}" || true

echo "Done. Start with: lai up   or   docker compose up -d"
