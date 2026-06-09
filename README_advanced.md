# LAI — advanced setup

For the standard **PyPI + Docker Hub** install, see the main **[README.md](README.md)**.

This guide covers:

- [Install from git](#install-from-git)
- [Build Docker images from scratch](#build-docker-images-from-scratch)
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
lai install         # terminal wizard (SAM 3 prompts)
lai install --yes   # non-interactive
```

With a git checkout, compose can **bind-mount** the host `backend/` for live code edits (`docker-compose.code-mount.yml`). The wizard configures this; see `scripts/install.sh`.

### Start without rebuilding images

If `.env` points at registry tags (`luluray/lai-*`):

```bash
lai up
```

If `.env` uses local tags (`*:local`), build first (see below), then:

```bash
lai up --build      # rebuild missing/outdated images, then start
```

### Develop the web UI only

```bash
npm ci
npm run dev
```

Vite dev server on **:8080** (proxies API). Full stack in Docker still uses **`lai up`** and the `web` container on **:8089**.

---

## Build Docker images from scratch

End users pull pre-built images. Developers build locally when changing Dockerfiles or dependencies.

### Automatic (recommended)

```bash
lai build           # ordered build: ML runtimes → backend → workers → web → sam
lai up --build      # build if needed, then start
```

Build order (see `scripts/build_stack.sh`):

1. `ultralytics_runtime`, `mmyolo_runtime` *(profile `build`)*
2. `backend`, `worker-gpu`, `worker-general`, `web`, `sam_service`

### Manual

```bash
# From repo root
docker compose --profile build build ultralytics_runtime mmyolo_runtime
docker compose build backend worker-gpu worker-general web sam_service

docker compose up -d
```

Or:

```bash
bash scripts/build_stack.sh           # build only if images missing
bash scripts/build_stack.sh --force   # full rebuild
```

**MMYOLO runtime note:** first `mmyolo_runtime` build compiles mmcv from source (20–60+ min) unless offline wheels are in `dockers/backend/wheels/`.

### Local image tags

Developer `.env` typically uses `lai-backend:local`, etc. Registry installs use:

```
docker.io/luluray/lai-backend:<version>
```

Set `LAI_DOCKERHUB_USER` when publishing or if pulls fail with the wrong namespace.

---

## Run tests

Run tests **on the host** (venv + Node). Production images omit `pytest`, Vitest, and Playwright.

| Suite | Host needs | Docker stack (`lai up`) |
|--------|------------|-------------------------|
| Frontend (Vitest) | Node 18+, `npm ci` | No |
| Python (`tests/python/`) | Python 3.10+, `pip install -r backend/requirements-backend.txt pytest` | No (most tests) |
| E2E (Playwright) | Node 18+, `npx playwright install chromium` | **Yes** — API on `:9999` |

### Python tests

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip
pip install -r backend/requirements-backend.txt pytest

pytest tests/python/
pytest tests/python -q -m "not training_smoke"
```

`tests/python/conftest.py` adds `backend/` to `PYTHONPATH`.

**GPU training smoke** (optional, needs `worker-gpu` + dataset):

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
