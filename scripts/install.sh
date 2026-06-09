#!/usr/bin/env bash
# Guided install: checks Docker / Compose, asks where to store data and which web port to use, then writes .env.
# Usage:
#   bash scripts/install.sh              # interactive
#   bash scripts/install.sh --yes        # non-interactive (defaults: ~/lai-data, web port 8089)
#   LAI_DATA_DIR=/data/lai WEB_PORT=3000 bash scripts/install.sh --yes
# Optional env (non-interactive): LAI_PRETRAINED_MODELS, LAI_DEPTH_MODELS
#   (all|minimal|none|comma-list — none = do not bake into image; download on first train/auto-annotate)
# Developer bind-mount: --bind-code (default) | --no-bind-code
#   LAI_REPO_ROOT = absolute path to repo root (default: this project). Used when bind-code is on.
#   COMPOSE_FILE in .env selects docker-compose.code-mount.yml so backend/celery see host …/backend over /app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
mkdir -p "$(dirname "$ENV_FILE")"

YES=0
BIND_CODE="" # 1=mount host backend, 0=image only; empty=use defaults below
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --bind-code) BIND_CODE=1 ;;
    --no-bind-code) BIND_CODE=0 ;;
    -h|--help)
      echo "Usage: $0 [--yes] [--help] [--bind-code | --no-bind-code]"
      echo "  --yes  Non-interactive: env LAI_DATA_DIR, WEB_PORT, optional SAM3_*, LAI_PRETRAINED_MODELS, LAI_DEPTH_MODELS."
      echo "  --bind-code      Mount host backend source at \$LAI_REPO_ROOT/backend → /app (default)."
      echo "  --no-bind-code   Use only the Python code baked into the image for /app (pull/pre-built images)."
      echo "  Non-interactive bind: set LAI_BIND_CODE=0 or LAI_BIND_CODE=1 with --yes; optional LAI_REPO_ROOT=/abs/path/to/repo."
      echo "  LAI_PRETRAINED_MODELS: all | minimal | none | comma-separated (e.g. yolo11,yolo26 or exact .pt names)."
      echo "  LAI_DEPTH_MODELS: all | minimal | none | comma-separated ONNX filenames."
      echo "  none = smallest Docker image; weights/onnx load on demand (needs network at runtime)."
      exit 0
      ;;
  esac
done

die() { echo "Error: $*" >&2; exit 1; }

echo "=========================================="
echo "  LAI — guided install"
echo "=========================================="
echo ""

# --- Prerequisites ---
if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed or not in PATH.
Install Docker Engine for your OS: https://docs.docker.com/engine/install/
Then run this script again."
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker is installed but not usable (is the daemon running? Try: sudo systemctl start docker).
Fix that, then run this script again."
fi

if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 plugin is missing (need: docker compose ...).
Install it: https://docs.docker.com/compose/install/
Then run this script again."
fi

compose_short="$(docker compose version --short 2>/dev/null || true)"
compose_short="${compose_short#v}"
if [[ -n "$compose_short" ]]; then
  major="${compose_short%%.*}"
  rest="${compose_short#*.}"
  minor="${rest%%.*}"
  minor="${minor%%[^0-9]*}"
  major="${major//[^0-9]/}"
  minor="${minor//[^0-9]/}"
  if [[ -z "$major" ]]; then major=0; fi
  if [[ -z "$minor" ]]; then minor=0; fi
  if [[ "$major" -lt 2 ]] || { [[ "$major" -eq 2 ]] && [[ "$minor" -lt 24 ]]; }; then
    die "Docker Compose is too old for this project (have ${compose_short}, need >= 2.24 for compose \"include\").
Upgrade Docker / Compose: https://docs.docker.com/compose/install/"
  fi
fi

if ! docker compose -f "$ROOT/docker-compose.yml" config >/dev/null 2>&1; then
  die "docker compose config failed. Upgrade to Compose 2.24+ or check docker-compose.yml."
fi

echo "Prerequisites OK: Docker and Docker Compose (${compose_short:-version unknown})."
echo ""

# --- Defaults ---
DEFAULT_DATA="$HOME/lai-data"
DEFAULT_WEB_PORT="8089"
DEFAULT_API_URL="SAME_ORIGIN"

prompt() {
  local text="$1"
  local def="$2"
  local out
  if [[ "$YES" -eq 1 ]]; then
    echo "$def"
    return
  fi
  read -r -p "$text [$def] " out || true
  if [[ -z "${out// /}" ]]; then
    echo "$def"
  else
    echo "$out"
  fi
}

# --- Data directory ---
echo "Data directory"
echo "  All databases, datasets, runs, and backups will be stored here (on your disk)."
echo "  Use a path on a drive with enough free space."
echo ""
if [[ -n "${LAI_DATA_DIR:-}" && "$YES" -eq 1 ]]; then
  DATA_DIR="$LAI_DATA_DIR"
else
  DATA_DIR="$(prompt "Path for LAI data (absolute path recommended)" "$DEFAULT_DATA")"
fi
# Expand ~ and make absolute
DATA_DIR="${DATA_DIR/#\~/$HOME}"
if [[ "$DATA_DIR" != /* ]]; then
  die "Please use an absolute path for data (e.g. $DEFAULT_DATA). Got: $DATA_DIR"
fi
if [[ "$YES" -eq 0 ]] && [[ ! -d "$DATA_DIR" ]]; then
  read -r -p "Create directory $DATA_DIR ? [Y/n] " mk || true
  case "${mk:-Y}" in
    [Nn]*) die "Create the folder first or choose another path." ;;
  esac
fi
mkdir -p "$DATA_DIR"

# --- Web UI port ---
echo ""
echo "Web UI port"
echo "  The app will open in your browser at http://localhost:<port>"
echo "  (The API stays on port 9999 unless you change compose yourself.)"
echo ""
if [[ -n "${WEB_PORT:-}" && "$YES" -eq 1 ]]; then
  WEB_P="$WEB_PORT"
else
  WEB_P="$(prompt "Port for the web interface" "$DEFAULT_WEB_PORT")"
fi
if ! [[ "$WEB_P" =~ ^[0-9]+$ ]] || [[ "$WEB_P" -lt 1 ]] || [[ "$WEB_P" -gt 65535 ]]; then
  die "Invalid port: $WEB_P"
fi

# --- Developer vs pull-only install ---
IS_DEVELOPER=0
if [[ -d "$ROOT/.git" ]] && [[ -d "$ROOT/backend" ]]; then
  IS_DEVELOPER=1
fi

# --- GPU tier (optional) ---
echo ""
echo "GPU tier (optional)"
echo "  Enables worker-gpu + sam_service for training, auto-annotate, and SAM."
echo "  Requires NVIDIA GPU + Container Toolkit. CPU-only installs can still annotate datasets."
echo ""
if [[ "$YES" -eq 1 ]]; then
  case "${LAI_GPU_TIER:-1}" in
    0|false|no|NO) GPU_TIER=0 ;;
    *) GPU_TIER=1 ;;
  esac
else
  read -r -p "Enable GPU tier (training / SAM)? [Y/n] " gt || true
  case "${gt:-Y}" in
    [Nn]*) GPU_TIER=0 ;;
    *) GPU_TIER=1 ;;
  esac
fi

# --- Repository root / bind host backend (developers) ---
echo ""
echo "Developer: host backend code"
echo "  When enabled, backend and Celery mount your repo’s backend/ over /app (see docker-compose.code-mount.yml)."
echo "  Disable for pull-only installs (pip install laivision + registry images)."
echo ""
if [[ -z "$BIND_CODE" ]]; then
  if [[ "$IS_DEVELOPER" -eq 0 ]]; then
    BIND_CODE=0
  elif [[ "$YES" -eq 1 ]]; then
    case "${LAI_BIND_CODE:-1}" in
      0|false|False|no|NO) BIND_CODE=0 ;;
      *) BIND_CODE=1 ;;
    esac
  else
    read -r -p "Mount host backend from disk for live code edits? [Y/n] " bc || true
    case "${bc:-Y}" in
      [Nn]*) BIND_CODE=0 ;;
      *) BIND_CODE=1 ;;
    esac
  fi
fi

if [[ -n "${LAI_REPO_ROOT:-}" ]] && [[ "$YES" -eq 1 ]]; then
  REPO_ROOT="${LAI_REPO_ROOT/#\~/$HOME}"
elif [[ "$YES" -eq 1 ]]; then
  REPO_ROOT="$ROOT"
else
  REPO_ROOT="$(prompt "Repository root (absolute path; contains backend/ and docker-compose.yml)" "$ROOT")"
  REPO_ROOT="${REPO_ROOT/#\~/$HOME}"
fi
if [[ "$REPO_ROOT" != /* ]]; then
  die "Repository root must be an absolute path. Got: $REPO_ROOT"
fi
if [[ "$BIND_CODE" -eq 1 ]] && [[ ! -d "$REPO_ROOT/backend" ]]; then
  die "Expected a backend/ directory under $REPO_ROOT (set LAI_REPO_ROOT or clone the full repo)."
fi

# --- Pretrained weights (backend Docker build): Ultralytics + Depth Anything ---
echo ""
echo "Pretrained models (Docker build)"
echo "  When you run docker compose build, the backend image can include YOLO .pt weights"
echo "  (Auto-Annotate / export) and Depth Anything ONNX files. Smaller presets save disk and time."
echo ""
echo "  Licensing (YOLO & RT-DETR via Ultralytics): the OSS package is AGPL-3.0 —"
echo "    https://github.com/ultralytics/ultralytics — pretrained weights / commercial terms:"
echo "    https://www.ultralytics.com/license"
echo ""
if [[ "$YES" -eq 1 ]]; then
  PT_SPEC="${LAI_PRETRAINED_MODELS:-all}"
  DEPTH_SPEC="${LAI_DEPTH_MODELS:-all}"
else
  echo "  1) all — full YOLO matrix + all depth models (largest download)"
  echo "  2) minimal — YOLO11 nano/small heads + one depth model (smaller image)"
  echo "  3) custom — you type values for LAI_PRETRAINED_MODELS and LAI_DEPTH_MODELS"
  echo "  4) none — do not bake weights/onnx into the image; download on first use (train / auto-annotate / depth)"
  read -r -p "Choice [1/2/3/4, default 1] " pt_choice || true
  case "${pt_choice:-1}" in
    2)
      PT_SPEC="minimal"
      DEPTH_SPEC="minimal"
      ;;
    3)
      read -r -p "LAI_PRETRAINED_MODELS [all|minimal|none|yolo11,...] " PT_SPEC || true
      PT_SPEC="${PT_SPEC:-all}"
      read -r -p "LAI_DEPTH_MODELS [all|minimal|none|filename,...] " DEPTH_SPEC || true
      DEPTH_SPEC="${DEPTH_SPEC:-all}"
      ;;
    4)
      PT_SPEC="none"
      DEPTH_SPEC="none"
      ;;
    *)
      PT_SPEC="all"
      DEPTH_SPEC="all"
      ;;
  esac
fi

# --- SAM 3 (optional): folder on disk + checkpoint filename ---
echo ""
echo "SAM 3 weights (optional)"
echo "  Choose the folder that will contain your SAM 3 checkpoint (default is under this repo)."
DEFAULT_SAM3_DIR="$ROOT/backend/sam_service/models"
DEFAULT_SAM3_FILE="sam3.pt"
if [[ "$YES" -eq 1 ]]; then
  SAM3_IN="${SAM3_MODELS_HOST_PATH:-$DEFAULT_SAM3_DIR}"
  SAM3_IN="${SAM3_IN/#\~/$HOME}"
  if [[ "$SAM3_IN" != /* ]]; then
    SAM3_RESOLVED="$(cd "$ROOT" && realpath -m "$SAM3_IN")"
  else
    SAM3_RESOLVED="$SAM3_IN"
  fi
  SAM3_CF="${SAM3_CHECKPOINT_FILENAME:-$DEFAULT_SAM3_FILE}"
else
  SAM3_IN="$(prompt "Folder for SAM 3 weights" "$DEFAULT_SAM3_DIR")"
  SAM3_IN="${SAM3_IN/#\~/$HOME}"
  if [[ "$SAM3_IN" != /* ]]; then
    SAM3_RESOLVED="$(cd "$ROOT" && realpath -m "$SAM3_IN")"
  else
    SAM3_RESOLVED="$SAM3_IN"
  fi
  SAM3_CF="$(prompt "Checkpoint file name inside that folder" "$DEFAULT_SAM3_FILE")"
fi
mkdir -p "$SAM3_RESOLVED"

# --- Write .env ---
upsert_env() {
  local key="$1"
  local val="$2"
  local tmp
  tmp="$(mktemp)"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    grep -v "^${key}=" "$ENV_FILE" >"$tmp" || true
    printf '%s=%s\n' "$key" "$val" >>"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

if [[ -f "$ENV_FILE" ]] && [[ "$YES" -eq 0 ]]; then
  cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  echo "Backed up existing .env to $ENV_FILE.bak.*"
fi

upsert_env LAI_DATA_DIR "$DATA_DIR"
upsert_env WEB_PORT "$WEB_P"
upsert_env VITE_API_URL "${VITE_API_URL:-$DEFAULT_API_URL}"
upsert_env SAM3_MODELS_HOST_PATH "$SAM3_RESOLVED"
upsert_env SAM3_CHECKPOINT_FILENAME "$SAM3_CF"
upsert_env LAI_PRETRAINED_MODELS "$PT_SPEC"
upsert_env LAI_DEPTH_MODELS "$DEPTH_SPEC"
upsert_env LAI_REPO_ROOT "$REPO_ROOT"
# Windows treats ':' in COMPOSE_FILE as a drive letter; use ';' between compose files.
COMPOSE_SEP=":"
if [[ "${OS:-}" == "Windows_NT" ]] || [[ "${OSTYPE:-}" == msys* ]] || [[ "${OSTYPE:-}" == cygwin* ]]; then
  COMPOSE_SEP=";"
fi
if [[ "$BIND_CODE" -eq 1 ]]; then
  upsert_env COMPOSE_FILE "docker-compose.code-mount.yml${COMPOSE_SEP}docker-compose.yml"
else
  upsert_env COMPOSE_FILE "docker-compose.yml"
fi

upsert_env LAI_GPU_TIER "$GPU_TIER"
if [[ "$GPU_TIER" -eq 1 ]]; then
  upsert_env COMPOSE_PROFILES "gpu"
else
  upsert_env COMPOSE_PROFILES ""
fi

if [[ "$IS_DEVELOPER" -eq 0 ]] || [[ "$BIND_CODE" -eq 0 ]]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 "$ROOT/scripts/write_registry_env.py" --env "$ENV_FILE" --bundle-root "$ROOT" --gpu-tier "$GPU_TIER" \
      ${LAI_RELEASE_VERSION:+--version "$LAI_RELEASE_VERSION"} || true
  fi
fi

echo ""
echo "Wrote to $ENV_FILE:"
echo "  LAI_DATA_DIR=$DATA_DIR"
echo "  WEB_PORT=$WEB_P"
echo "  VITE_API_URL=${VITE_API_URL:-$DEFAULT_API_URL}"
echo "  SAM3_MODELS_HOST_PATH=$SAM3_RESOLVED"
echo "  SAM3_CHECKPOINT_FILENAME=$SAM3_CF"
echo "  LAI_PRETRAINED_MODELS=$PT_SPEC"
echo "  LAI_DEPTH_MODELS=$DEPTH_SPEC"
echo "  LAI_REPO_ROOT=$REPO_ROOT"
if [[ "$BIND_CODE" -eq 1 ]]; then
  echo "  COMPOSE_FILE=docker-compose.code-mount.yml${COMPOSE_SEP}docker-compose.yml (host backend bind)"
else
  echo "  COMPOSE_FILE=docker-compose.yml (image /app only)"
fi
echo ""

# Subdirs for compose bind mounts
mkdir -p \
  "$DATA_DIR/postgres" \
  "$DATA_DIR/redis" \
  "$DATA_DIR/mongodb" \
  "$DATA_DIR/projects" \
  "$DATA_DIR/data" \
  "$DATA_DIR/backups" \
  "$DATA_DIR/runs"
echo "Created data subfolders under $DATA_DIR"

# --- SAM 3 checkpoint file ---
SAM3_FULL="$SAM3_RESOLVED/$SAM3_CF"
echo ""
if [[ -f "$SAM3_FULL" ]]; then
  echo "SAM 3: checkpoint found at $SAM3_FULL"
else
  echo "SAM 3 weights: not found at"
  echo "  $SAM3_FULL"
  echo "SAM 3 stays disabled until you add that file (SAM 2 still works)."
  echo "See: https://huggingface.co/facebook/sam3"
  echo ""
  if [[ "$YES" -eq 1 ]] || [[ "${SAM3_SKIP_PROMPT:-}" == "1" ]] || [[ "${CI:-}" == "true" ]]; then
    echo "Continuing without SAM 3 (--yes / SAM3_SKIP_PROMPT / CI)."
  else
    read -r -p "Continue without SAM 3 weights? [Y/n] " ans || true
    case "${ans:-Y}" in
      [Nn]*) echo "Stopped. Add the checkpoint, then run this script again."; exit 1 ;;
      *) echo "OK — add the file later and restart the sam_service container." ;;
    esac
  fi
fi

echo ""
echo "=========================================="
echo "  Next steps"
echo "=========================================="
echo "  1. Pull:      lai pull   (registry images; skip if you build locally)"
echo "  2. Start:     lai up"
echo "  3. Open:      http://localhost:${WEB_P}"
echo "  (Next time you can use a browser wizard instead:  lai install-gui )"
echo ""
echo "Why Docker (not pip alone)?"
echo "  This stack needs PostgreSQL, Redis, MongoDB, GPU SAM, and Celery."
echo "  Docker keeps versions consistent; a pip-only install would still"
echo "  require installing and configuring each service by hand."
echo ""
