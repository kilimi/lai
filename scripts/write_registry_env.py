#!/usr/bin/env python3
"""Write Docker registry image tags to .env for pull-only installs."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lai.registry import is_developer_checkout, release_version, write_registry_env  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Write registry image tags to .env")
    p.add_argument("--env", type=Path, required=True, help="Path to .env file")
    p.add_argument("--bundle-root", type=Path, default=ROOT, help="Bundle / repo root")
    p.add_argument("--gpu-tier", choices=("0", "1"), default="0")
    p.add_argument("--version", default="", help="Release version tag (default: lai package version)")
    p.add_argument("--force", action="store_true", help="Write even in a developer checkout")
    args = p.parse_args()

    bundle_root = args.bundle_root.resolve()
    if not args.force and is_developer_checkout(bundle_root):
        print("Developer checkout — skipping registry image tags (local :local build).")
        return 0

    ver = args.version.strip() or release_version()
    write_registry_env(
        args.env.resolve(),
        version=ver,
        gpu_tier=args.gpu_tier == "1",
        bind_code=False,
    )
    print(f"Wrote registry image tags (version={ver.lstrip('v')}, gpu_tier={args.gpu_tier}) to {args.env}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
