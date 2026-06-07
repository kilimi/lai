#!/usr/bin/env bash
# Build ML runtime images and workers (subset of scripts/build_stack.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$ROOT/scripts/build_stack.sh" "$@"
