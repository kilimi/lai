from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List, Optional
from datetime import datetime
import asyncio
import json
import os
import base64
import shutil
from pathlib import Path
import logging
import sys

# Configure logging — stdout only; no FileHandler to avoid double I/O on every request
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)

# Create logger
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

import re

_DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8000",
    "http://localhost:8080",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8089",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:8082",
    "http://127.0.0.1:8089",
]

_ORIGIN_RE = re.compile(
    r"https?://("
    r"localhost|127\.0\.0\.1|\[::1\]|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$"
)


def _build_cors_origins() -> list[str]:
    """Merge defaults with ALLOWED_ORIGINS from docker-compose / .env."""
    origins = list(_DEFAULT_CORS_ORIGINS)
    extra = os.environ.get("ALLOWED_ORIGINS", "")
    for item in extra.split(","):
        origin = item.strip()
        if origin and origin not in origins:
            origins.append(origin)
    return origins


_CORS_ORIGINS = _build_cors_origins()
_ALLOWED_ORIGINS = set(_CORS_ORIGINS)

def _origin_allowed(origin: Optional[str]) -> bool:
    return bool(origin and (origin in _ALLOWED_ORIGINS or _ORIGIN_RE.match(origin)))


def _add_cors(response: Response, origin: Optional[str]) -> None:
    """Attach CORS headers to an existing response object in-place."""
    if _origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin  # type: ignore[assignment]
        response.headers["Access-Control-Allow-Credentials"] = "true"
        # Chromium Private Network Access (SPA on LAN IP → API on localhost)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    else:
        response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "*"

from app.services.media_service import (
    MEDIA_TYPES,
    THUMB_SUFFIXES,
    etag_for_path,
    generate_thumbnail_sync,
    prewarm_thumbnails,
    resolve_thumbnail_path,
)

from . import models, schemas
from .database import engine, get_db
from app.db_bootstrap import wait_for_database

wait_for_database(engine, models.Base.metadata)

app = FastAPI()

# Ensure required directories exist
Path("data").mkdir(exist_ok=True)
Path("projects").mkdir(exist_ok=True)


def _cors_json_response(
    request: Request,
    *,
    status_code: int,
    content: dict,
) -> JSONResponse:
    response = JSONResponse(status_code=status_code, content=content)
    _add_cors(response, request.headers.get("origin"))
    return response


@app.exception_handler(HTTPException)
async def http_exception_with_cors(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if not isinstance(detail, (str, dict, list)):
        detail = str(detail)
    return _cors_json_response(request, status_code=exc.status_code, content={"detail": detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_with_cors(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return _cors_json_response(request, status_code=422, content={"detail": exc.errors()})


@app.exception_handler(Exception)
async def unhandled_exception_with_cors(request: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled error on %s %s: %s", request.method, request.url.path, exc, exc_info=True)
    return _cors_json_response(
        request,
        status_code=500,
        content={"detail": "Internal server error"},
    )


# CORS: explicit origins + regex for localhost/LAN dev ports (see ALLOWED_ORIGINS in docker-compose)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_origin_regex=_ORIGIN_RE.pattern,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.middleware("http")
async def private_network_access_cors(request: Request, call_next):
    """
    Chromium may block cross-origin requests to loopback from a LAN page origin unless
    the preflight/response includes Access-Control-Allow-Private-Network.
    """
    origin = request.headers.get("origin")
    wants_pna = request.headers.get("access-control-request-private-network", "").lower() == "true"

    if request.method == "OPTIONS" and wants_pna and _origin_allowed(origin):
        headers = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Allow-Methods": request.headers.get(
                "access-control-request-method", "GET, POST, PUT, PATCH, DELETE, OPTIONS"
            ),
            "Access-Control-Allow-Headers": request.headers.get(
                "access-control-request-headers", "*"
            ),
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        return Response(status_code=204, headers=headers)

    response = await call_next(request)
    if _origin_allowed(origin):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

# Add a simple test endpoint for debugging CORS
@app.get("/test-cors")
async def test_cors(request: Request):
    """Simple endpoint to test CORS configuration"""
    origin = request.headers.get("origin")
    response = JSONResponse(content={"message": "CORS test successful", "origin": origin})
    _add_cors(response, origin)
    return response

# Mount static files directories - COMMENTED OUT TO USE CUSTOM HANDLERS
# app.mount("/data", StaticFiles(directory="data"), name="data")
# app.mount("/static/projects", StaticFiles(directory="projects"), name="projects")

# Add OPTIONS handler for static files CORS preflight
@app.options("/static/projects/{file_path:path}")
async def options_project_files(file_path: str, request: Request):
    """Handle CORS preflight requests for static files"""
    origin = request.headers.get("origin")
    headers = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    }
    if origin and (origin in _ALLOWED_ORIGINS or _ORIGIN_RE.match(origin)):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    else:
        headers["Access-Control-Allow-Origin"] = "*"
    return JSONResponse(content={}, headers=headers)

# Custom static file handlers with explicit CORS
@app.get("/static/projects/{file_path:path}")
async def serve_project_files(file_path: str, request: Request, thumb: Optional[int] = None):
    """Serve project images with optional thumbnail generation.

    Thumbnails are generated in a thread-pool executor (non-blocking) and cached
    indefinitely via Cache-Control + ETag so repeat visits skip the download.
    """
    full_path = Path("projects") / file_path

    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    suffix = full_path.suffix.lower()
    media_type = MEDIA_TYPES.get(suffix)

    serve_path = full_path
    if thumb and suffix in THUMB_SUFFIXES:
        thumb_size = min(thumb, 800)
        thumb_path = resolve_thumbnail_path(full_path, thumb_size)
        if not thumb_path.exists():
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None, generate_thumbnail_sync, full_path, thumb_path, thumb_size
            )
        if thumb_path.exists():
            serve_path = thumb_path

    etag = etag_for_path(serve_path)

    if etag and request.headers.get("if-none-match") == etag:
        resp_304 = Response(status_code=304)
        _add_cors(resp_304, request.headers.get("origin"))
        return resp_304

    response = FileResponse(
        path=str(serve_path),
        media_type=media_type,
        filename=serve_path.name,
    )

    if etag:
        response.headers["ETag"] = etag
    if thumb:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "public, max-age=3600"

    _add_cors(response, request.headers.get("origin"))
    return response

@app.options("/data/{file_path:path}")
async def options_data_files(file_path: str, request: Request):
    """Handle CORS preflight requests for data files"""
    origin = request.headers.get("origin")
    headers = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    }
    if origin and (origin in _ALLOWED_ORIGINS or _ORIGIN_RE.match(origin)):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    else:
        headers["Access-Control-Allow-Origin"] = "*"
    return JSONResponse(content={}, headers=headers)

@app.get("/data/{file_path:path}")
async def serve_data_files(file_path: str, request: Request):
    """Custom handler for data static files with explicit CORS"""
    full_path = Path("data") / file_path

    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    suffix = full_path.suffix.lower()
    response = FileResponse(
        path=str(full_path),
        media_type=MEDIA_TYPES.get(suffix),
        filename=full_path.name,
    )
    _add_cors(response, request.headers.get("origin"))
    return response

# Ensure exports directory exists
Path("static/exports").mkdir(parents=True, exist_ok=True)

# Add OPTIONS handler for exports CORS preflight
@app.options("/static/exports/{file_path:path}")
async def options_export_files(file_path: str, request: Request):
    """Handle CORS preflight requests for export files"""
    origin = request.headers.get("origin")
    headers = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    }
    if origin and (origin in _ALLOWED_ORIGINS or _ORIGIN_RE.match(origin)):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    else:
        headers["Access-Control-Allow-Origin"] = "*"
    return JSONResponse(content={}, headers=headers)

# Custom static file handler for exports
@app.get("/static/exports/{file_path:path}")
async def serve_export_files(file_path: str, request: Request):
    """Custom handler for export files with explicit CORS"""
    full_path = Path("static/exports") / file_path
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Export file not found")
    response = FileResponse(
        path=str(full_path),
        media_type="application/octet-stream",
        filename=full_path.name,
    )
    _add_cors(response, request.headers.get("origin"))
    return response

# Ensure inference_results directory exists
Path("static/inference_results").mkdir(parents=True, exist_ok=True)

@app.options("/static/inference_results/{file_path:path}")
async def options_inference_files(file_path: str, request: Request):
    """Handle CORS preflight requests for inference result files"""
    origin = request.headers.get("origin")
    headers = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    }
    if origin and (origin in _ALLOWED_ORIGINS or _ORIGIN_RE.match(origin)):
        headers["Access-Control-Allow-Origin"] = origin
    else:
        headers["Access-Control-Allow-Origin"] = "*"
    return JSONResponse(content={}, headers=headers)

# Custom static file handler for inference results
@app.get("/static/inference_results/{file_path:path}")
async def serve_inference_files(file_path: str, request: Request):
    """Custom handler for inference result images with explicit CORS"""
    full_path = Path("static/inference_results") / file_path
    if not full_path.exists() or not full_path.is_file():
        raise HTTPException(status_code=404, detail="Inference result file not found")
    suffix = full_path.suffix.lower()
    response = FileResponse(
        path=str(full_path),
        media_type=MEDIA_TYPES.get(suffix, "image/jpeg"),
        filename=full_path.name,
    )
    _add_cors(response, request.headers.get("origin"))
    return response

# CORS middleware is handled by the custom middleware above
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=allowed_origins,
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
#     expose_headers=["*"],
#     max_age=3600,
# )

# Mount static files directories - COMMENTED OUT TO USE CUSTOM HANDLERS
# app.mount("/data", StaticFiles(directory="data"), name="data")
# app.mount("/static/projects", StaticFiles(directory="projects"), name="projects")


def _reconcile_pause_requested_tasks_on_startup() -> None:
    """Mark orphaned running tasks as paused after backend restart.

    If pause was requested but the worker never reached the epoch boundary before restart,
    tasks can be left as 'running' forever. This reconciles those to 'paused'.
    """
    recovered = 0
    try:
        with Session(bind=engine) as db:
            running_tasks = db.query(models.Task).filter(models.Task.status == "running").all()
            for task in running_tasks:
                metadata = task.task_metadata or {}
                if not isinstance(metadata, dict):
                    continue
                if not metadata.get("pause_requested_at"):
                    continue

                task.status = "paused"
                task.task_metadata = {
                    **metadata,
                    "stage": "paused",
                    "pause_requested_at": None,
                    "paused_recovered_at": datetime.utcnow().isoformat(),
                }
                recovered += 1

            if recovered:
                db.commit()
                logger.warning("Recovered %d pause-requested running task(s) to paused on startup", recovered)
    except Exception as exc:
        logger.error("Failed startup task reconciliation: %s", exc, exc_info=True)


@app.on_event("startup")
async def startup_prewarm_thumbnails() -> None:
    """Fire-and-forget thumbnail pre-generation so first page loads are fast."""
    _reconcile_pause_requested_tasks_on_startup()
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, prewarm_thumbnails, Path("projects"))


@app.get("/health-check")
async def health_check(db: Session = Depends(get_db)):
    """Health check endpoint that verifies both API and database connectivity"""
    try:
        # Test database connection by executing a simple query
        db.execute(text("SELECT 1"))
        db.commit()
        
        return {
            "status": "ok",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        # Still return 200 but indicate database issue
        return {
            "status": "degraded",
            "database": "disconnected",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }


# Import routers
from .routers import projects, datasets, tasks, augmentations, dataset_groups, annotation_db, image_collections, segmentation, database_backup, training, predictions, backup, export, pipelines, auto_annotation, preannotate, system, models_api

from app.ml.backends import register_all_backends

register_all_backends()

# Include routers
app.include_router(system.router)
app.include_router(projects.router)
app.include_router(datasets.router)
app.include_router(tasks.router)
app.include_router(augmentations.router)
app.include_router(dataset_groups.router)
app.include_router(annotation_db.router)
app.include_router(image_collections.router)
app.include_router(segmentation.router)
app.include_router(database_backup.router)
app.include_router(training.router)
app.include_router(models_api.router)
app.include_router(predictions.router)
app.include_router(backup.router)
app.include_router(export.router)
app.include_router(pipelines.router)
app.include_router(auto_annotation.router)
app.include_router(preannotate.router)