# Background workers and Docker images

## Services

| Compose service | Image | Queues | Role |
|-----------------|-------|--------|------|
| `worker-general` | `lai-worker-general` | `general` | Dataset duplicate, augmentation, annotations, depth ONNX |
| `worker-gpu` | `lai-worker-gpu` | `gpu`, `mmyolo` | YOLO train/eval/export, auto-annotate; MMYOLO via subprocess |
| `celery-beat` | `lai-worker-general` | — | Backup schedule, stale-task watchdog |

## Development

With bind-mounted code (`docker-compose.code-mount.yml`), edit files under `backend/` and restart only the affected worker:

```bash
docker compose restart worker-general   # app / CPU task changes
docker compose restart worker-gpu       # GPU task changes (no rebuild unless ML deps changed)
```

Rebuild ML images only when lockfiles change:

```bash
docker compose build worker-gpu
docker compose build worker-general
```

## ML dependency locks

- YOLO stack: `backend/constraints-ml-yolo.txt`
- Pin in `backend/constraints-ml-yolo.txt` and `requirements-worker-gpu.txt` (`ultralytics>=8.4.0`; YOLO26 needs 8.4+)

## Legacy

The old monolithic `celery_worker` + `Dockerfile.training` setup was removed. Reference copy: `backend/Dockerfile.training.legacy`.
