#!/usr/bin/env bash
# Developer pipeline: local :local image tags → ordered compose build → up -d
# Prefer: lai dev   (after pip install -e .)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NO_CACHE=()
for arg in "$@"; do
  case "$arg" in
    --no-cache|--force) NO_CACHE+=(--no-cache) ;;
  esac
done

if [[ -d "$ROOT/.git" ]] && [[ -d "$ROOT/backend" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
from pathlib import Path
import sys
sys.path.insert(0, '${ROOT}')
from lai.compose_build import ensure_developer_build_env
if ensure_developer_build_env(Path('${ROOT}')):
    print('Updated .env: local :local image tags for developer builds.')
" || true
  fi
fi

echo "==> Ordered build (ML runtimes first — do not interrupt)"
bash "$ROOT/scripts/build_stack.sh" "${NO_CACHE[@]}"

echo "==> Start stack"
docker compose up -d "$@"
