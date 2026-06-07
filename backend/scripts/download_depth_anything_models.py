#!/usr/bin/env python3
"""Download Depth-Anything ONNX models if they don't exist."""

import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.foundation_models import resolve_depth_models_spec


def download_depth_models() -> None:
    models_dir = Path("ai_models/depth_estimation")
    models_dir.mkdir(parents=True, exist_ok=True)

    spec = os.environ.get("LAI_DEPTH_MODELS", "all")
    models_to_download = resolve_depth_models_spec(spec)

    if not models_to_download:
        print(
            f"LAI_DEPTH_MODELS={spec!r} → bake no Depth Anything ONNX into image. "
            "Models download on first depth run if applicable (needs network).",
            flush=True,
        )
        return

    base_url = "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0"

    existing_models = list(models_dir.glob("depth_anything_v2_vit*"))
    existing_names = {model.name for model in existing_models}

    if existing_names:
        print(f"Found existing Depth-Anything models in {models_dir}:")
        for model in sorted(existing_names):
            print(f"  ✓ {model}")

    print(f"LAI_DEPTH_MODELS={spec!r} → {len(models_to_download)} file(s)")

    downloaded_count = 0
    for model_name in models_to_download:
        model_path = models_dir / model_name

        if model_path.exists():
            print(f"⊘ Skipping {model_name} (already exists)")
            continue

        model_url = f"{base_url}/{model_name}"
        print(f"\nDownloading {model_name}...")
        print(f"  URL: {model_url}")

        try:
            urllib.request.urlretrieve(model_url, model_path)

            if model_path.exists():
                file_size = model_path.stat().st_size / (1024 * 1024)
                print(f"  ✓ Successfully downloaded ({file_size:.2f} MB)")
                downloaded_count += 1
            else:
                print("  ✗ Error: File was not created")

        except Exception as e:
            print(f"  ✗ Error downloading model: {e}")
            raise

    if downloaded_count > 0:
        print(f"\n✓ Downloaded {downloaded_count} new model(s)")
    else:
        print("\n✓ All requested models already present")


if __name__ == "__main__":
    download_depth_models()
