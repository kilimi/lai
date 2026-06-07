# Offline wheels for `mmyolo_runtime`

OpenMMLab CDN (`download.openmmlab.com`) is **not used** by this Dockerfile.
`mim install mmcv` is intentionally avoided — it always tries that CDN.

## Default build (no wheels here)

- **mmengine** — PyPI
- **mmcv** — compiled from GitHub `v2.0.1` (slow, 20–60+ min)
- **mmdet** — PyPI
- **mmyolo** — GitHub

## Fast path: pre-download mmcv wheel on the host

If you can reach OpenMMLab from your **browser** (not from Docker):

```bash
cd dockers/backend/wheels
curl -L -O "https://download.openmmlab.com/mmcv/dist/cu113/torch1.10.0/mmcv-2.0.1%2Btorch1.10.0cu113-cp38-cp38-manylinux2014_x86_64.whl"
```

Then rebuild — skips the long GitHub compile.

## Rebuild

```bash
docker compose --profile build build mmyolo_runtime --progress=plain
```

If compile OOMs: `--build-arg MMCV_BUILD_JOBS=1`
