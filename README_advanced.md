# LAI — advanced setup

For the standard **PyPI + Docker Hub** install, see the main **[README.md](README.md)**.

This guide covers:

- [Install from git](#install-from-git)
- [Build Docker images from scratch](#build-docker-images-from-scratch)
- [INSID3 / DINOv3 weights](#insid3--dinov3-weights)
- [Run tests](#run-tests)
- [Repo layout](#repo-layout)
- [Workers and database](#workers-and-database)
- [Maintainer releases](#maintainer-releases)
- [License](#license)

---

## Install from git

You need **Docker Engine**, **Compose v2.24+**, and **Python 3.10+**.

```bash
git clone https://github.com/kilimi/lai.git
cd lai

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -U pip
pip install -e .

lai --version
lai doctor
```

**pipx** (editable install, isolated env):

```bash
cd lai
pipx install -e .
```

**Conda:**

```bash
conda env create -f environment.yml
conda activate lai-cli
# then: pip install -e .   if you want the repo checkout, not only PyPI laivision
```

### Guided setup (developer checkout)

```bash
lai install-gui     # browser wizard — writes .env in the repo root
# or:
lai install         # terminal wizard (SAM 3 + DINOv3 paths)
lai install --yes   # non-interactive; sets lai-*:local image tags when .git present
```

With a git checkout, compose can **bind-mount** the host `backend/` for live code edits (`docker-compose.code-mount.yml`). The wizard configures this; see `scripts/install.sh`.

### Build and start (developer)

```bash
lai dev             # one-shot: :local tags → ordered build → up -d
# or:
lai build && lai up
```

Avoid `docker compose up --build` — it builds `backend` before `lai-mmyolo:local` exists.

### Develop the web UI only

```bash
npm ci
npm run dev
```

Vite dev server on **:8080** (proxies API). Full stack in Docker still uses **`lai up`** and the `web` container on **:8089**.

---

## Build Docker images from scratch

End users pull pre-built images. Developers build locally when changing Dockerfiles or dependencies.

**Do not run** `docker compose up --build` or plain `docker compose build` — Compose does not know that `backend` depends on a locally built `lai-mmyolo:local` image. You will get `pull access denied` for `lai-mmyolo:local`.

### Developer pipeline (one command)

```bash
pip install -e .          # once
lai install --yes         # writes .env with lai-*:local tags + code bind
lai dev                   # ordered build + docker compose up -d
```

`lai dev --no-cache` forces a full rebuild. On Windows without bash: `.\scripts\dev.ps1` or `lai dev`.

### Automatic (recommended)

```bash
lai build           # ordered build: ML runtimes → backend → workers → web → sam
lai up --build      # build if needed, then start
lai up              # start only (builds missing images in order)
```

Build order (see `scripts/build_stack.sh`):

1. `ultralytics_runtime`, `mmyolo_runtime` *(profile `build`)*
2. `backend`, `worker-gpu`, `worker-general`, `web`, `sam_service`

### Manual

```bash
# From repo root
bash scripts/build_stack.sh
docker compose up -d
```

Or:

```bash
bash scripts/dev.sh           # ensure :local tags + build + up
bash scripts/build_stack.sh --no-cache   # full rebuild
```

**MMYOLO / mmcv** — by default `MMCV_USE_PREBUILT=1` (fast OpenMMLab wheel, ~2 min). Works on most NVIDIA GPUs (sm_60–sm_86 / RTX 20–30 series).

If the prebuilt install fails (network) or you want a fully offline build:

```powershell
.\scripts\fetch_mmyolo_mmcv_wheel.ps1   # Windows
# bash scripts/fetch_mmyolo_mmcv_wheel.sh   # Git Bash / Linux
lai build
```

**RTX 40xx / 50xx** (sm_89+): prebuilt mmcv lacks your GPU arch. In `.env` set `MMCV_USE_PREBUILT=0`, give Docker **16GB+ RAM**, then `lai build --no-cache` (30–60+ min source compile). Optional: `MMCV_BUILD_JOBS=1` to reduce memory pressure.

Build-time smoke tests only **import** the MMYOLO stack (no `init_detector`) so `docker build` does not SIGILL on Windows Docker Desktop; full MMYOLO training is verified at runtime on the GPU worker.

### Local image tags

Developer `.env` (from `lai install` or `lai dev`) uses `lai-backend:local`, etc. `lai doctor` reports missing images and reminds you to use `lai dev`, not `docker compose up --build`.

Registry installs use:

```
docker.io/luluray/lai-backend:<version>
```

Set `LAI_DOCKERHUB_USER` when publishing or if pulls fail with the wrong namespace.

---

## INSID3 / DINOv3 weights

*From example (INSID3)* segmentation in `sam_service` needs DINOv3 checkpoints on the host. The install wizard writes **`DINOV3_WEIGHTS_HOST_PATH`** in `.env` — a **folder** (not a single file). Docker mounts it read-only at **`/models/dinov3`** inside `sam_service`.

INSID3 defaults to **`model_size=base`** (ViT-B, 768-dim). The checkpoint must match that size; a ViT-S (`vits16`, 384-dim) file will not load even if renamed.

### Exact filenames (`sam_service` lookup)

| INSID3 `model_size` | Variant | Canonical filename (preferred) |
|---------------------|---------|--------------------------------|
| `base` (default) | ViT-B / 768-dim | `dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth` |
| `small` | ViT-S / 384-dim | `dinov3_vits16_pretrain_lvd1689m-08c60483.pth` |
| `large` | ViT-L / 1024-dim | `dinov3_vitl16_pretrain_lvd1689m-8aa4cbdd.pth` |

Place **one** of the files above in `DINOV3_WEIGHTS_HOST_PATH`, then restart `sam_service`:

```bash
docker compose up -d sam_service --force-recreate
```

### HuggingFace export names (also accepted)

If you save weights with `torch.save(model.state_dict(), ...)` from `transformers`, a hyphenated name works too — for example:

- `dinov3-vitb16-pretrain-lvd1689m.pth` → accepted for `model_size=base`
- `dinov3-vits16-pretrain-lvd1689m.pth` → only for `model_size=small`

`sam_service` detects these alternate names, converts HuggingFace key layout to Meta format when needed, and links the file into INSID3’s `pretrain/` directory under the canonical name.

**HuggingFace export (ViT-B, default):**

```python
import torch
from transformers import AutoModel

model = AutoModel.from_pretrained(
    "facebook/dinov3-vitb16-pretrain-lvd1689m",
    token="hf_...",  # gated model — request access on Hugging Face first
)
torch.save(
    model.state_dict(),
    r"C:\path\to\weights\dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth",  # or dinov3-vitb16-pretrain-lvd1689m.pth
)
```

Use **`vitb16`**, not `vits16`, unless you intentionally run INSID3 with `model_size=small` everywhere.

### Download without HuggingFace

Meta CDN (already in Meta/torch.hub format, no conversion):

```text
https://dl.fbaipublicfiles.com/dinov3/dinov3_vitb16/dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth
```

Or from the repo (writes into `DINOV3_WEIGHTS_DIR`):

```bash
export DINOV3_WEIGHTS_DIR=/path/to/your/weights   # same folder as DINOV3_WEIGHTS_HOST_PATH
python backend/scripts/download_dinov3_models.py
```

### Verify mount and startup logs

```bash
docker compose exec sam_service ls -la /models/dinov3
docker compose logs sam_service | grep DINOv3
```

Healthy startup shows the resolved file, for example:

```text
[DINOv3] DINOV3_WEIGHTS_DIR=/models/dinov3, canonical=dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth, resolved=dinov3-vitb16-pretrain-lvd1689m.pth, exists=True
```

If `exists=False` or `Found .pth files: (none)`, the host path in `.env` is wrong or the filename does not match any row in the table above.

---

## Run tests

Run tests **on the host** (venv + Node). Production images omit `pytest`, Vitest, and Playwright.

| Suite | Host needs | Docker stack (`lai up`) |
|--------|------------|-------------------------|
| Frontend (Vitest) | Node 18+, `npm ci` | No |
| Python (`tests/python/`) | Python 3.10+, `pip install -r tests/python/requirements.txt` | No (most tests) |
| GPU training smoke | Same as Python + Docker Compose v2 | **Yes** — healthy `worker-gpu` |
| E2E (Playwright) | Node 18+, `npx playwright install chromium` | **Yes** — API on `:9999` |

### Python tests

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip
pip install -r tests/python/requirements.txt

pytest tests/python/
pytest tests/python -q -m "not training_smoke and not insid3_smoke"
```

**INSID3 tests** (`test_insid3_mask_utils.py`, `test_insid3_same_image.py`):

- Host unit tests need `numpy`, `pillow`, `opencv` (included via `requirements.txt` → `requirements-sam-unit.txt`).
- Same-image inference smoke (`-m insid3_smoke`) runs **inside `sam_service`** via `docker compose exec` when pytest is on the host. Requires GPU profile, running `sam_service`, and DINOv3 weights in `DINOV3_WEIGHTS_HOST_PATH`. Recreate the service after compose changes so `/tests` is mounted:

```bash
docker compose up -d sam_service --force-recreate
pytest tests/python/test_insid3_same_image.py -m insid3_smoke -v
```

Optional (fewer skipped tests on host; large download):

```bash
pip install -r tests/python/requirements-gpu-extras.txt
```

`tests/python/conftest.py` adds `backend/` to `PYTHONPATH`.

**GPU training smoke** (from host — uses running `worker-gpu` container):

```bash
# Stack must be up with GPU profile (lai up / COMPOSE_PROFILES=gpu)
set LAI_RUN_TRAINING_SMOKE=1          # Windows
# export LAI_RUN_TRAINING_SMOKE=1     # Linux/macOS

pytest tests/python/test_training_env.py -v
pytest tests/python/test_training_smoke_all_models.py -m training_smoke -v
```

Tests are **skipped** when `worker-gpu` is not running or not healthy. Override compose location if needed:

```bash
set LAI_COMPOSE_PROJECT_DIR=E:\projects\NewLai\lai
```

Filter models (optional): `LAI_TRAINING_SMOKE_MODELS=yolo/yolo11n-seg.pt,mmyolo/rtmdet_s`

Legacy: run pytest inside the container manually:

```bash
docker compose exec -e LAI_RUN_TRAINING_SMOKE=1 -e LAI_BACKEND_DIR=/app worker-gpu \
  bash -lc 'pip install -q pytest && pytest /tests/python/test_training_smoke_all_models.py -m training_smoke -v'
```

### Frontend unit tests

```bash
npm ci
npm run tests              # CI-style single run
npm run test               # watch mode
npm run test:coverage
```

### End-to-end tests (Playwright)

```bash
lai up
curl http://localhost:9999/health-check

npm ci
npx playwright install chromium
npm run test:e2e
```

- Playwright starts Vite on **:8080** and hits the API on **:9999**
- Global setup clears the DB via `DELETE http://localhost:9999/database/clear`

```bash
pytest tests/python/ && npm run tests && npm run test:e2e
# or: npm run test:all   (Vitest + Playwright; run pytest separately)
```

### Marketing / demo captures

```bash
npx playwright test --config=playwright.marketing.config.ts
```

Output under `docs/flows/`.

---

## Repo layout

| Path | Role |
|------|------|
| `src/` | React frontend |
| `backend/` | FastAPI, Celery workers, migrations |
| `dockers/` | Dockerfiles; root `docker-compose.yml` includes `dockers/` |
| `lai/` | Python CLI (`pip install -e .` or PyPI `laivision`) |
| `scripts/` | `install.sh`, `build_stack.sh`, model download helpers |
| `tests/` | Python, Vitest, Playwright |

---

## Workers and database

- **`worker-general`** — CPU queue: datasets, augmentation, annotations, depth ONNX, Celery Beat  
- **`worker-gpu`** — GPU queue: YOLO/MMYOLO train & eval, auto-annotate  

Schema: Alembic migrations and `LAI_DB_AUTO_CREATE` run on backend startup.

```bash
docker compose up -d worker-general worker-gpu celery-beat
```

---

## Maintainer releases

### Docker Hub (GitHub Actions)

1. Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`
2. Actions → **Docker publish** → run with tag (e.g. `0.1.0`)

Images: `luluray/lai-backend`, `lai-worker-gpu`, `lai-worker-general`, `lai-frontend`, `lai-sam`, `lai-ultralytics`, `lai-mmyolo`.

### PyPI (GitHub Actions)

1. Secret: `PYPI_API_TOKEN`
2. Bump `pyproject.toml`, `package.json`, `backend/VERSION` together
3. Actions → **PyPI release** → version (e.g. `0.1.0`)

Package name: **`laivision`** · command: **`lai`**.

Publish **Docker images before** the PyPI wheel so image tags exist when users run `lai up`.

### Uninstall (users)

```bash
lai uninstall              # type DELETE to confirm; removes data + ~/.config/lai/.env
lai uninstall --no-rmi     # keep Docker images
```

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

| Component | License |
|-----------|---------|
| LAI + Ultralytics YOLO | AGPL-3.0 — [Ultralytics Enterprise](https://www.ultralytics.com/license) for closed-source use |
| MMYOLO / OpenMMLab | GPL-3.0 |
| SAM 2 | Apache-2.0 |
| SAM 3 | Meta SAM License |

If you distribute Docker images bundling these runtimes, include upstream license files and comply with each license.
