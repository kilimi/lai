#!/bin/bash
# Manage GPU background worker (YOLO / MMYOLO)

ACTION=$1

case $ACTION in
  start)
    echo "Starting GPU worker..."
    docker compose up -d worker-gpu
    ;;
  stop)
    docker compose stop worker-gpu
    ;;
  restart)
    docker compose restart worker-gpu
    ;;
  logs)
    docker compose logs -f worker-gpu
    ;;
  build)
    docker compose build worker-gpu
    ;;
  status)
    docker compose ps worker-gpu worker-general celery-beat
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|logs|build|status}"
    exit 1
    ;;
esac
