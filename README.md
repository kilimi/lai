# LAI

Annotation and dataset stack. The **`lai`** CLI drives **Docker Compose** (Docker Engine + Compose **v2.24+** required).

## Install (end users — pull-only)

No git clone or local image builds. Full guide: [docs/INSTALL_USERS.md](docs/INSTALL_USERS.md).

```bash
pip install lai          # or: pipx install lai
lai install-gui          # data folder, port, CPU vs GPU tier
lai up                   # pulls Docker Hub images if needed, starts stack
```

Open **`http://localhost:<WEB_PORT>`** (default **8089**). Stop: `lai down`. Upgrade: `lai upgrade`.

**Requires:** Docker Engine + Compose **v2.24+**. GPU tier needs NVIDIA Container Toolkit.

## Develop from source

```bash
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -U pip && pip install -e .

lai install-gui    # browser wizard: data directory + port (or: lai install)
lai up             # docker compose up -d (no rebuild)
lai up --build     # rebuild local images first
```

**On Debian/Ubuntu:** do not `pip install` on system Python (PEP 668). Use the venv above or **`pipx install -e .`**.

## Develop the web UI only

```bash
npm ci
npm run dev
```

Uses Vite (see `package.json`). The full app runs in Docker via `lai up`.

## Repo layout

- `src/` — React frontend
- `backend/` — API, workers, database migrations
- `dockers/` — Dockerfiles and Compose stack (`docker-compose.yml` at repo root includes `dockers/`)
- `lai/` — Python CLI (`pip install -e .`)
- `deploy/` — nginx config for the frontend image
- `scripts/` — `install.sh`, SAM check helper

## Background workers

CPU tasks (`worker-general`) and GPU tasks (`worker-gpu`) use separate Docker images and Celery queues. See [docs/WORKERS.md](docs/WORKERS.md) and [docs/BACKGROUND_TASKS.md](docs/BACKGROUND_TASKS.md) (production requires Celery workers).

## Database

Schema policy (`LAI_DB_AUTO_CREATE`, Alembic on container start): [docs/DATABASE.md](docs/DATABASE.md).

Service layer map: [docs/BACKGROUND_TASKS.md](docs/BACKGROUND_TASKS.md#service-layer-p1).

```bash
docker compose build worker-general worker-gpu
docker compose up -d worker-general worker-gpu celery-beat
```

## Tests

Run **unit and integration tests on your host** (repo checkout + venv / Node). Do **not** run them inside production Compose images (`backend`, `web`, `worker-*`) — those images omit dev tools (`pytest`, Vitest, Playwright).

**E2E** needs the **API stack in Docker** (`backend`, `db`, `redis`, …). Playwright starts the **Vite dev server on the host** (`:8080`), not the `web` nginx container (`:8089`).

### Prerequisites

| Suite | Host needs | Docker stack (`lai up`) |
|--------|------------|-------------------------|
| Frontend unit (Vitest) | Node 18+, `npm ci` | No |
| Python (`tests/python/`) | Python 3.10+, venv, `pip install -r backend/requirements-backend.txt pytest` | No (most tests); API tests use in-memory SQLite |
| E2E (Playwright) | Node 18+, `npm ci`, `npx playwright install chromium` | **Yes** — API reachable at `http://localhost:9999` |

From the **repository root** (directory that contains `docker-compose.yml`).

### Python tests (`tests/python/`)

On the **host** (recommended):

```bash
python3 -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate

pip install -U pip
pip install -r backend/requirements-backend.txt pytest

# All Python tests
pytest tests/python/
pytest tests/python -q -m "not training_smoke"
# GPU training smoke (5 epochs on tests/python/test_dataset/car_dataset):
# worker-gpu: backend is /app; tests are mounted at /tests (see dockers/backend/docker-compose.yml).
# Recreate worker after compose changes: docker compose up -d worker-gpu
#
# PowerShell (exec does NOT support -v; volume is in compose):
#   docker compose exec -e LAI_RUN_TRAINING_SMOKE=1 -e LAI_BACKEND_DIR=/app worker-gpu bash -lc 'pip install -q pytest && pytest /tests/python/test_training_smoke_all_models.py -m training_smoke -v'
# MMYOLO only:
#   docker compose exec -e LAI_RUN_TRAINING_SMOKE=1 -e LAI_BACKEND_DIR=/app -e LAI_TRAINING_SMOKE_MODELS=mmyolo/rtmdet_s worker-gpu bash -lc 'pip install -q pytest && pytest /tests/python/test_training_smoke_all_models.py -m training_smoke -v'

# Examples
pytest tests/python/test_projects_api.py
pytest tests/python/test_celery_*.py -q

`tests/python/conftest.py` adds `backend/` to `PYTHONPATH`; you do **not** need `docker compose exec` into `lai-backend-1` for these.

Optional — run inside the **backend container** only for debugging (install pytest into the running container; not persisted in the image):

```bash
docker compose exec backend pip install pytest
docker compose exec backend pytest /app/../tests/python/   # only if tests are bind-mounted
```

With `docker-compose.code-mount.yml` enabled, prefer host `pytest` instead.

### Frontend unit tests (Vitest, `npm`)

On the **host**, repo root:

```bash
npm ci

npm run tests              # single run (CI-style)
npm run test               # watch mode
npm run test:coverage

# Scope examples
npm run tests -- src/lib/projects-list.test.ts
npm run tests -- src/tests/pages/Index.test.tsx
```

Config: `vite.config.ts` (`test` section). No container required.

### End-to-end tests (Playwright, `tests/e2e/`)

On the **host**, with the **stack up**:

```bash
lai up          # or: docker compose up -d db redis backend
# API must answer: curl http://localhost:9999/health-check

npm ci
npx playwright install chromium

npm run test:e2e

# Project page flows only
npx playwright test tests/e2e/projects
npx playwright test tests/e2e/test-navigation.spec.ts
```

How it works:

- **Global setup** calls `DELETE http://localhost:9999/database/clear` on the running **backend** service (container `lai-backend-1`, host port **9999**).
- Playwright’s **webServer** runs `npm run dev` → UI at **`http://localhost:8080`** (proxies `/projects`, `/datasets`, … to the API).
- Override API URL: `TEST_API_URL=http://127.0.0.1:9999`
- Override UI URL: `TEST_WEB_URL` or `PLAYWRIGHT_BASE_URL` (if not using the built-in Vite server).

Do **not** point E2E only at the `web` service (`:8089`) unless you set `PLAYWRIGHT_BASE_URL` and skip `webServer`; the default flow expects Vite on **8080** + API on **9999**.

Workers (`worker-general`, `worker-gpu`) are **not** used to run these test commands.

### Run everything (host)

```bash
pytest tests/python/ && npm run tests && npm run test:e2e
```

Or: `npm run test:all` (Vitest + Playwright; run `pytest` separately).

### Marketing / demo flows

```bash
npx playwright test --config=playwright.marketing.config.ts
```

Produces screenshots and video under `docs/flows/` (requires API on `:9999` and Vite on `:8080`).

See **GPU training smoke** under [Tests](#tests) above.

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

| Component | License | Details |
|-----------|---------|---------|
| LAI + Ultralytics YOLO | AGPL-3.0 | [LICENSE](LICENSE) — [Ultralytics Enterprise](https://www.ultralytics.com/license) for closed-source use |
| MMYOLO / OpenMMLab | GPL-3.0 | [licenses/GPL-3.0.txt](licenses/GPL-3.0.txt) |
| SAM 2 | Apache-2.0 | [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt) |
| SAM 3 | Meta SAM License | [licenses/SAM-3-Meta.txt](licenses/SAM-3-Meta.txt) |

Full attribution and redistribution notes: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and [NOTICE](NOTICE).

If you distribute Docker images or releases that bundle these ML runtimes, include the license files above and comply with each upstream license (especially AGPL-3.0 for YOLO, GPL-3.0 for MMYOLO, and Meta’s SAM License for SAM 3).
