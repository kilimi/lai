@echo off
REM Script to manage YOLO training service

SET ACTION=%1

IF "%ACTION%"=="start" (
    echo Starting YOLO training service...
    docker-compose up -d training
    echo Training service started on port 9998
    echo Check logs with: docker-compose logs -f training
    GOTO :EOF
)

IF "%ACTION%"=="stop" (
    echo Stopping YOLO training service...
    docker-compose stop training
    GOTO :EOF
)

IF "%ACTION%"=="restart" (
    echo Restarting YOLO training service...
    docker-compose restart training
    GOTO :EOF
)

IF "%ACTION%"=="logs" (
    docker-compose logs -f training
    GOTO :EOF
)

IF "%ACTION%"=="build" (
    echo Building YOLO training service...
    docker-compose build training
    GOTO :EOF
)

IF "%ACTION%"=="rebuild" (
    echo Rebuilding YOLO training service (no cache)...
    docker-compose build --no-cache training
    GOTO :EOF
)

IF "%ACTION%"=="shell" (
    echo Opening shell in training container...
    docker-compose exec training /bin/bash
    GOTO :EOF
)

IF "%ACTION%"=="status" (
    docker-compose ps training
    GOTO :EOF
)

echo YOLO Training Service Manager
echo.
echo Usage: manage_training.bat [command]
echo.
echo Commands:
echo   start    - Start the training service
echo   stop     - Stop the training service
echo   restart  - Restart the training service
echo   logs     - View training service logs
echo   build    - Build the training service image
echo   rebuild  - Rebuild without cache
echo   shell    - Open bash shell in training container
echo   status   - Show training service status
