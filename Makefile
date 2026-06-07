# Run from repository root. Requires Docker Compose v2.24+ (for `include` in docker-compose.yml).
COMPOSE ?= docker compose
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# Run from repository root. Requires Docker Compose v2.24+ (for `include` in docker-compose.yml).
COMPOSE ?= docker compose
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# Foundation model selection for `make download-models`.
# Values: all | minimal | none | comma list (e.g. yolo11,yolo11n-seg.pt)
LAI_PRETRAINED_MODELS ?= minimal
LAI_DEPTH_MODELS ?= minimal

.PHONY: install check-sam3 up down logs ps build pull up-no-build download-models help

help:
	@echo "Targets: install | check-sam3 | up | down | logs | ps | build | pull | up-no-build | download-models"
	@echo "  install         guided setup: Docker/Compose, data dir, web port, SAM 3, optional host code bind"
	@echo "  check-sam3      exit 1 if SAM 3 weights missing (for scripts/CI)"
	@echo "  up              docker compose up -d (build if needed)"
	@echo "  down            stop stack"
	@echo "  pull            pull images (set LAI_*_IMAGE in .env first)"
	@echo "  up-no-build     start without building (after pull)"
	@echo "  build           build all images"
	@echo "  logs            follow logs"
	@echo "  ps              service status"
	@echo "  download-models fetch foundation YOLO + Depth-Anything weights into the host volume"
	@echo "                  (preferred CLI: 'lai download-models [--yolo SPEC] [--depth SPEC]')"
	@echo "                  override which weights with LAI_PRETRAINED_MODELS / LAI_DEPTH_MODELS"

install:
	bash "$(ROOT)/scripts/install.sh"

check-sam3:
	@bash "$(ROOT)/scripts/check_sam3.sh"

up:
	cd "$(ROOT)" && $(COMPOSE) up -d

down:
	cd "$(ROOT)" && $(COMPOSE) down

logs:
	cd "$(ROOT)" && $(COMPOSE) logs -f

ps:
	cd "$(ROOT)" && $(COMPOSE) ps

build:
	cd "$(ROOT)" && $(COMPOSE) build

pull:
	cd "$(ROOT)" && $(COMPOSE) pull

up-no-build:
	cd "$(ROOT)" && $(COMPOSE) up -d --no-build

download-models:
	cd "$(ROOT)" && $(COMPOSE) exec \
		-e LAI_PRETRAINED_MODELS=$(LAI_PRETRAINED_MODELS) \
		worker-gpu python scripts/download_ultralytics_models.py
	cd "$(ROOT)" && $(COMPOSE) exec \
		-e LAI_PRETRAINED_MODELS=$(LAI_PRETRAINED_MODELS) \
		-e LAI_DEPTH_MODELS=$(LAI_DEPTH_MODELS) \
		backend python scripts/download_depth_anything_models.py
