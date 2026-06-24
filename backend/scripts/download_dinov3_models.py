#!/usr/bin/env python3
"""Download DINOv3 .pth weights for INSID3 into DINOV3_WEIGHTS_DIR."""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.foundation_models import dinov3_meta_cdn_url, resolve_dinov3_models_spec

_LICENSE_HINT = (
    "DINOv3 weights are gated — request access at "
    "https://huggingface.co/facebook/dinov3-vitb16-pretrain-lvd1689m "
    "(log in, accept license, wait for approval), then place .pth files in DINOV3_WEIGHTS_DIR."
)


def _download_with_urllib(url: str, dest: Path) -> None:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "LAI-download-models/1.0"},
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        tmp.replace(dest)


def _download_with_torch(url: str, dest: Path) -> None:
    import torch

    state = torch.hub.load_state_dict_from_url(url, map_location="cpu", weights_only=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    torch.save(state, dest)


def _download_file(url: str, dest: Path) -> None:
    try:
        _download_with_urllib(url, dest)
        return
    except urllib.error.HTTPError as exc:
        if exc.code not in (403, 401):
            raise
        print(f"  Meta CDN returned HTTP {exc.code}; trying torch.hub fallback...", flush=True)
    except urllib.error.URLError:
        print("  urllib download failed; trying torch.hub fallback...", flush=True)

    try:
        _download_with_torch(url, dest)
    except Exception as exc:
        raise RuntimeError(f"{_LICENSE_HINT}\nOriginal error: {exc}") from exc


def download_dinov3_models() -> None:
    models_dir = Path(os.environ.get("DINOV3_WEIGHTS_DIR", "/models/dinov3"))
    spec = os.environ.get("LAI_DINOV3_MODELS", "minimal")
    to_fetch = resolve_dinov3_models_spec(spec)

    if not to_fetch:
        print(
            f"LAI_DINOV3_MODELS={spec!r} → skip DINOv3 download.",
            flush=True,
        )
        return

    print(f"LAI_DINOV3_MODELS={spec!r} → {len(to_fetch)} file(s) into {models_dir}", flush=True)

    downloaded = 0
    for filename in to_fetch:
        dest = models_dir / filename
        if dest.is_file() and dest.stat().st_size > 0:
            size_mb = dest.stat().st_size / (1024 * 1024)
            print(f"⊘ Skipping {filename} (already exists, {size_mb:.1f} MB)", flush=True)
            continue

        url = dinov3_meta_cdn_url(filename)
        print(f"\nDownloading {filename}...", flush=True)
        print(f"  URL: {url}", flush=True)
        _download_file(url, dest)
        size_mb = dest.stat().st_size / (1024 * 1024)
        print(f"  ✓ Saved ({size_mb:.1f} MB)", flush=True)
        downloaded += 1

    if downloaded:
        print(f"\n✓ Downloaded {downloaded} new DINOv3 checkpoint(s)", flush=True)
    else:
        print("\n✓ All requested DINOv3 checkpoints already present", flush=True)


if __name__ == "__main__":
    download_dinov3_models()
