#!/usr/bin/env python3
"""GPU training environment checks (run inside worker-gpu)."""
from __future__ import annotations

import argparse
import sys


def check_imports() -> None:
    packages = ("torch", "torchvision", "ultralytics", "cv2", "numpy", "PIL")
    failed = []
    for package in packages:
        try:
            __import__(package)
        except ImportError as exc:
            failed.append(f"{package}: {exc}")
    if failed:
        raise SystemExit("Import failures: " + "; ".join(failed))


def check_cuda() -> None:
    import torch

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is not available")
    x = torch.randn(32, 32, device="cuda")
    _ = x @ x.t()


def check_ultralytics() -> None:
    __import__("ultralytics")


_CHECKS = {
    "imports": check_imports,
    "cuda": check_cuda,
    "ultralytics": check_ultralytics,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("check", nargs="?", default="all")
    args = parser.parse_args(argv)

    if args.check == "all":
        names = list(_CHECKS)
    elif args.check in _CHECKS:
        names = [args.check]
    else:
        parser.error(f"unknown check {args.check!r}; choose from: all, {', '.join(_CHECKS)}")
    for name in names:
        _CHECKS[name]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
