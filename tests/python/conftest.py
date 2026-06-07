import sys

from path_utils import resolve_backend_dir

BACKEND_DIR = resolve_backend_dir()

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
