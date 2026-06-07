#!/usr/bin/env python3
"""
CI guard: fail if application source hardcodes http://localhost:9999.

Allowed: src/config/api.ts (defaults), ApiSettings placeholder, tests, demo.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
NEEDLE = "localhost:9999"

# Paths that may mention the default API port intentionally.
ALLOWLIST = {
    SRC / "config" / "api.ts",
    SRC / "config" / "api.test.ts",
    SRC / "pages" / "ApiSettings.tsx",
    SRC / "test" / "setup.ts",
}

SKIP_DIR_NAMES = {"tests", "test", "demo"}


def _allowed(path: Path) -> bool:
    if path in ALLOWLIST:
        return True
    rel = path.relative_to(SRC)
    if rel.parts and rel.parts[0] in SKIP_DIR_NAMES:
        return True
    if path.name.endswith((".test.ts", ".test.tsx")):
        return True
    return False


def main() -> int:
    violations: list[str] = []
    for path in sorted(SRC.rglob("*")):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        if _allowed(path):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"warn: skip {path}: {exc}", file=sys.stderr)
            continue
        if NEEDLE in text:
            for i, line in enumerate(text.splitlines(), 1):
                if NEEDLE in line:
                    violations.append(f"{path.relative_to(ROOT)}:{i}: {line.strip()[:120]}")
    if violations:
        print(
            "Hardcoded API URL found in application source. "
            "Use getApiBaseUrl() or buildApiUrl() from @/config/api.\n",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        return 1
    print("OK: no hardcoded localhost:9999 in src/ (excluding allowlist and tests)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
