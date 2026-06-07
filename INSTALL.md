# Install and start LAI

The **`lai`** command is a small CLI that drives **Docker Compose**. You need **Docker Engine** and **Docker Compose v2.24+** on the machine (`docker compose` must work).

**End users (no git clone):** see [docs/INSTALL_USERS.md](docs/INSTALL_USERS.md).

---

## 1. Install the `lai` CLI

### From PyPI (recommended for end users)

```bash
pipx install lai
# or, inside a venv:
pip install lai
```

The wheel includes compose files under `lai/bundle/`. Your settings are written to **`~/.config/lai/.env`** (not inside site-packages).

### From this repository (developers)

```bash
cd /path/to/ai-data-creator

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -U pip
pip install -e .
```

Confirm:

```bash
lai --version
lai doctor
```

**pipx** (isolated app environment, no manual venv):

```bash
cd /path/to/ai-data-creator
pipx install -e .
```

### Debian / Ubuntu: avoid system `pip`

Do **not** run `pip install …` on the **system** Python. You will get **externally-managed-environment** ([PEP 668](https://peps.python.org/pep-0668/)). Use **venv**, **pipx**, or **conda** (see below) instead.

### Conda

Create an environment from the repo (uses PyPI when `lai` is published):

```bash
conda env create -f environment.yml
conda activate lai-cli
```

If `lai` is not on PyPI yet, use any conda env with Python + `pip`, activate it, then from the repo root:

```bash
pip install -e .
```

### From PyPI (end users)

Already covered above — use `pip install lai` then `lai install-gui`.

For editable installs from a git checkout, the repo root is used directly instead of the embedded bundle.

Legacy fallback: set **`LAI_BUNDLE_URL`** to download a tarball if the embedded bundle is missing.

---

## 2. First-time setup (guided install)

After the CLI is on your PATH:

```bash
lai install-gui
```

Browser wizard on `127.0.0.1` — choose data directory and web port (default web **8089**).

Terminal alternative (includes SAM checkpoint prompts):

```bash
lai install
```

Non-interactive defaults (see `scripts/install.sh` for env vars):

```bash
lai install --yes
```

---

## 3. Start the stack

```bash
lai up
```

Open the app: `http://localhost:<WEB_PORT>` (default **8089**, or whatever you set during install).

Useful commands:

| Command | Purpose |
|--------|---------|
| `lai doctor` | Version, bundle path, Docker / Compose checks |
| `lai down` | Stop containers |
| `lai compose -- ps` | Container status |
| `lai compose -- logs -f` | Follow logs |

Equivalent without the CLI (from repo root): `make up`, `make down`, or `docker compose up -d`.

### GPU training images (first build or after dependency changes)

`lai up` builds missing local images automatically in this order:

1. `ultralytics_runtime` + `mmyolo_runtime`
2. `celery_worker`
3. `backend`, `web`, `sam_service`

To force a full rebuild: `lai up --build` or `lai build`.

Manual equivalent:

```bash
bash scripts/build_stack.sh --force   # rebuild all
bash scripts/build_stack.sh           # build only if images missing
docker compose up -d
```

---

## 4. Remove the stack and local data

Stops Compose, can remove images and project data (you must confirm by typing `DELETE`):

```bash
lai uninstall
```

Keep Docker images: `lai uninstall --no-rmi`. This does **not** remove your git checkout or optional SAM weights paths you configured.

---

## 5. Publishing the CLI to PyPI (maintainers)

```bash
python -m build
# upload the wheel/sdist with your usual tool (twine, etc.)
```

If the PyPI name **`lai`** is taken, change **`name`** in `pyproject.toml` and update docs accordingly.
