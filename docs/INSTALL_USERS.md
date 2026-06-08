# Install LAI (end users)

No git clone required. You install a small CLI from PyPI, run a setup wizard, pull pre-built Docker images from Docker Hub, and start the stack.

## Requirements

| Requirement | Notes |
|-------------|--------|
| **Docker Engine** | [Install Docker](https://docs.docker.com/engine/install/) |
| **Docker Compose v2.24+** | `docker compose version` must work |
| **Python 3.10+** | For the `lai` CLI only (venv, pipx, or conda) |
| **Disk space** | ~5 GB CPU-only; ~20–30 GB with GPU images |
| **NVIDIA GPU** (optional) | Training, auto-annotate, SAM — needs [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) |

You do **not** need Node.js, the application source repo, or local image builds.

## Quick start

```bash
pip install laivision
# or: pipx install laivision

lai install-gui          # data folder, web port, CPU vs GPU tier
lai up                   # pulls Docker Hub images if needed, starts stack
```

Open **http://localhost:8089** (or the port you chose). Stop with `lai down`.

Non-interactive setup:

```bash
lai install --yes
lai up
```

## What gets installed where

| Path | Purpose |
|------|---------|
| `~/.config/lai/.env` | Your settings (data dir, ports, Docker image tags) |
| `~/lai-data/` (default) | Databases, datasets, projects, model cache |
| Python `site-packages/lai/bundle/` | Read-only compose files (inside the pip package) |

Configuration is stored outside the pip package so upgrades do not overwrite your settings.

## GPU tier

During `lai install-gui`, enable **GPU tier** to start `worker-gpu` and `sam_service`. This pulls larger images and requires an NVIDIA GPU.

Verify after start:

```bash
docker compose exec worker-gpu nvidia-smi
```

## Optional: foundation models

After the stack is running:

```bash
lai download-models --yolo yolov8n.pt    # Ultralytics training weights
lai download-models --mmyolo minimal       # MMYOLO pretrained checkpoints
lai download-models                        # full minimal set
```

Weights are stored under `$LAI_DATA_DIR/models`.

## Optional: SAM 3 weights

SAM 2 works without extra downloads. For SAM 3, download a checkpoint from [Hugging Face](https://huggingface.co/facebook/sam3) to the folder you set in the wizard (default: `~/lai-data/sam3-models/sam3.pt`), then restart:

```bash
lai restart sam_service
```

## Upgrade

```bash
pip install -U laivision
lai upgrade
```

This refreshes the CLI bundle, pulls new image tags from your `.env`, and recreates containers.

## Uninstall

```bash
lai uninstall
```

Stops containers, removes data (with confirmation), and deletes `~/.config/lai/.env`. Does not remove SAM weights you placed elsewhere.

## Troubleshooting

```bash
lai doctor                 # versions, bundle path, Docker checks
lai compose -- ps          # container status
lai compose -- logs -f backend
```

**Windows:** use Git Bash or WSL for `lai install` (terminal wizard). `lai install-gui` works in any browser.

**Debian/Ubuntu:** do not `pip install` on system Python (PEP 668). Use `pipx install laivision` or a venv.

## Maintainer release (Docker Hub + PyPI)

1. Set GitHub secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `PYPI_API_TOKEN`
2. **Docker images:** GitHub → Actions → **Docker publish** → Run workflow (choose tag, e.g. `latest` or `0.1.0`)
3. **PyPI wheel:** GitHub → Actions → **PyPI release** → Run workflow (enter version, e.g. `0.1.0`)

Bump `pyproject.toml`, `package.json`, and `backend/VERSION` together before a release. The UI footer reads the version from the backend (`GET /system/version`).

Default image namespace: `docker.io/lulu/lai-*` (override with `LAI_DOCKERHUB_USER` when building the bundle).
