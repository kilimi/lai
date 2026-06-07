#!/bin/bash
# CLI Commands for Training Models Without GUI
# ==============================================

# STEP 1: Get your dataset and annotation IDs
# --------------------------------------------
# First, find your project ID, dataset ID, and annotation file ID from the web UI
# Or query the API:

# List all projects
curl http://localhost:9999/projects

# List datasets for a project (replace 4 with your project ID)
curl http://localhost:9999/projects/4/datasets

# List annotations for a dataset (replace DATASET_ID)
curl http://localhost:9999/datasets/DATASET_ID/annotations


# STEP 2: Start YOLO Training
# ----------------------------

# Option 1: Using API (RECOMMENDED - goes through Celery queue)
curl -X POST http://localhost:9999/api/training/yolo/start \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": 4,
    "dataset_configs": [
      {
        "dataset_id": 5,
        "annotation_file_id": "default_annotations",
        "image_collection": "train",
        "split": {"train": 80, "val": 20, "test": 0}
      }
    ],
    "model_type": "yolo11n-seg.pt",
    "epochs": 100,
    "batch_size": 16,
    "image_size": 640,
    "device": "0",
    "optimizer": "auto",
    "learning_rate": 0.01,
    "momentum": 0.937,
    "weight_decay": 0.0005,
    "task_name": "YOLO Training from CLI"
  }'

# Option 2: Direct docker exec (NOT RECOMMENDED - bypasses queue)
docker compose exec worker-gpu python -c "
import sys
sys.path.insert(0, '/app')
from app.tasks.yolo_training import train_yolo_model

# Replace with your actual task ID from database
task_id = 100

training_config = {
    'task_id': task_id,
    'model_type': 'yolo11n-seg.pt',
    'data_yaml': '/app/projects/4/training/yolo_20241126_120000/data.yaml',
    'epochs': 100,
    'batch_size': 16,
    'image_size': 640,
    'device': '0',
    'output_dir': '/app/projects/4/training/yolo_20241126_120000',
    'patience': 50,
    'optimizer': 'auto',
    'learning_rate': 0.01,
    'momentum': 0.937,
    'weight_decay': 0.0005,
    'use_wandb': False
}

train_yolo_model(task_id, training_config)
"


# STEP 3: Start RT-DETR Training
# -------------------------------

curl -X POST http://localhost:9999/api/training/rtdetr \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": 4,
    "dataset_configs": [
      {
        "dataset_id": 5,
        "annotation_file_id": "default_annotations",
        "image_collection": "train",
        "split": {"train": 80, "val": 20, "test": 0}
      }
    ],
    "model_type": "rtdetr-r50.pt",
    "epochs": 100,
    "batch_size": 16,
    "image_size": 640,
    "device": "0",
    "optimizer": "AdamW",
    "learning_rate": 0.0001,
    "weight_decay": 0.0001,
    "task_name": "RT-DETR Training from CLI"
  }'


# STEP 4: Check Task Status
# --------------------------

# Get status of a specific task (replace 100 with your task ID)
curl http://localhost:9999/api/training/task/100/status

# Get all tasks for a project
curl http://localhost:9999/projects/4/tasks


# STEP 5: Monitor Training Progress
# ----------------------------------

# Watch task progress (refresh every 5 seconds)
watch -n 5 'curl -s http://localhost:9999/api/training/task/100/status | jq'

# Or check Celery Flower UI in browser
# http://localhost:5555


# STEP 6: View Training Results
# ------------------------------

# Training outputs are saved in:
# /app/projects/PROJECT_ID/training/MODEL_TIMESTAMP/training/

# Best model weights:
# /app/projects/PROJECT_ID/training/MODEL_TIMESTAMP/training/weights/best.pt

# Last checkpoint:
# /app/projects/PROJECT_ID/training/MODEL_TIMESTAMP/training/weights/last.pt

# Training results:
# /app/projects/PROJECT_ID/training/MODEL_TIMESTAMP/training/results.csv
# /app/projects/PROJECT_ID/training/MODEL_TIMESTAMP/training/results.png


# TROUBLESHOOTING
# ---------------

# Check if services are running
docker compose ps

# View logs
docker compose logs -f worker-gpu
docker compose logs -f worker-general

# Restart services
docker compose restart worker-gpu worker-general

# Access container shell
docker compose exec worker-gpu bash
docker compose exec worker-general bash
