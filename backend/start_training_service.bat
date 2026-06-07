@echo off
REM Quick start script for YOLO training service

echo ========================================
echo YOLO Training Service - Quick Start
echo ========================================
echo.

REM Check if Docker is running
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running!
    echo Please start Docker Desktop and try again.
    pause
    exit /b 1
)

echo Step 1: Building training service image...
echo This may take several minutes on first run...
docker-compose build training

if errorlevel 1 (
    echo ERROR: Failed to build training service
    pause
    exit /b 1
)

echo.
echo Step 2: Starting training service...
docker-compose up -d training

if errorlevel 1 (
    echo ERROR: Failed to start training service
    pause
    exit /b 1
)

echo.
echo Step 3: Waiting for service to be ready...
timeout /t 10 /nobreak >nul

echo.
echo Step 4: Testing environment...
docker-compose exec training python -c "import torch, ultralytics, cv2, numpy; print('Environment OK')"

echo.
echo ========================================
echo Training service is ready!
echo ========================================
echo.
echo Service URL: http://localhost:9998
echo View logs: manage_training.bat logs
echo Stop service: manage_training.bat stop
echo.

pause
