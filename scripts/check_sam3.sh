#!/usr/bin/env bash
# Exit 0 if SAM 3 checkpoint exists at paths from .env (or defaults).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
DIR="$ROOT/backend/sam_service/models"
FILE="sam3.pt"
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^# ]] && continue
    if [[ "$line" =~ ^SAM3_MODELS_HOST_PATH=(.*)$ ]]; then
      DIR="${BASH_REMATCH[1]//\"/}"
      DIR="${DIR//\'/}"
      DIR="${DIR#"${DIR%%[![:space:]]*}"}"
    fi
    if [[ "$line" =~ ^SAM3_CHECKPOINT_FILENAME=(.*)$ ]]; then
      FILE="${BASH_REMATCH[1]//\"/}"
      FILE="${FILE//\'/}"
      FILE="${FILE#"${FILE%%[![:space:]]*}"}"
    fi
  done <"$ENV_FILE"
fi
TARGET="$DIR/$FILE"
if [[ ! -f "$TARGET" ]]; then
  echo "Missing SAM 3 checkpoint: $TARGET (set SAM3_MODELS_HOST_PATH and SAM3_CHECKPOINT_FILENAME in .env, or run install)" >&2
  exit 1
fi
