# Run from repository root. Requires Docker Compose v2.24+ (for `include` in docker-compose.yml).
COMPOSE ?= docker compose
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# Foundation model selection for `make download-models` (YOLO + depth only).
LAI_PRETRAINED_MODELS ?= minimal
LAI_DEPTH_MODELS ?= minimal

# Prefer lai CLI when available (pip install -e .)
LAI_CMD := $(shell command -v lai 2>/dev/null)
ifeq ($(LAI_CMD),)
  ifneq ($(wildcard $(ROOT)/.venv/bin/lai),)
    LAI_CMD := $(ROOT)/.venv/bin/lai
  else ifneq ($(wildcard $(ROOT)/.venv/Scripts/lai.exe),)
    LAI_CMD := $(ROOT)/.venv/Scripts/lai.exe
  else
    LAI_CMD := python -m lai
  endif
endif

.PHONY: install check-sam3 dev build up up-build down logs ps pull up-no-build download-models help

help:
	@echo "Developer targets (ordered local builds — never plain 'docker compose build' alone):"
	@echo "  dev             lai dev — :local tags + ML runtimes first + up -d"
	@echo "  build           lai build — ordered image build only"
	@echo "  up              lai up — start (builds missing images in order)"
	@echo "  up-build        lai up --build — full local rebuild + start"
	@echo ""
	@echo "Other: install | check-sam3 | down | logs | ps | pull | up-no-build | download-models"
	@echo "  install         guided setup (writes .env with lai-*:local for git checkouts)"
	@echo "  download-models fetch YOLO + Depth + MMYOLO weights (lai download-models)"

install:
	bash "$(ROOT)/scripts/install.sh"

check-sam3:
	@bash "$(ROOT)/scripts/check_sam3.sh"

dev:
	cd "$(ROOT)" && $(LAI_CMD) dev

build:
	cd "$(ROOT)" && $(LAI_CMD) build

up:
	cd "$(ROOT)" && $(LAI_CMD) up

up-build:
	cd "$(ROOT)" && $(LAI_CMD) up --build

down:
	cd "$(ROOT)" && $(COMPOSE) down

logs:
	cd "$(ROOT)" && $(COMPOSE) logs -f

ps:
	cd "$(ROOT)" && $(COMPOSE) ps

pull:
	cd "$(ROOT)" && $(LAI_CMD) pull

up-no-build:
	cd "$(ROOT)" && $(COMPOSE) up -d --no-build

download-models:
	cd "$(ROOT)" && $(LAI_CMD) download-models
