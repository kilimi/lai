@echo off
echo Running Inpainting Container...
echo.

cd /d "e:\projects\lai\backend"

echo Choose an option:
echo 1. Run dependency check only
echo 2. Run quick inpainting test
echo 3. Run interactive container
echo 4. Start inpainting API service
echo 5. Check dependency compatibility (before building)
echo.

set /p choice="Enter your choice (1-5): "

if "%choice%"=="1" (
    echo Running dependency check...
    docker run --gpus all --rm lai-inpainting:stable python test_dependencies.py
) else if "%choice%"=="2" (
    echo Running quick inpainting test...
    docker run --gpus all --rm ^
        -v "%cd%\data:/app/data" ^
        lai-inpainting:stable python test_inpainting.py
) else if "%choice%"=="3" (
    echo Starting interactive container...
    docker run --gpus all -it --rm ^
        -v "%cd%\data:/app/data" ^
        -v "%cd%\python_scripts:/app/scripts" ^
        -v "%cd%\projects:/app/projects" ^
        lai-inpainting:stable
) else if "%choice%"=="4" (
    echo Starting API service...
    echo Note: Make sure inpainting_api.py is available in the container
    docker run --gpus all -p 8001:8000 --rm ^
        -v "%cd%\data:/app/data" ^
        -v "%cd%\python_scripts:/app/scripts" ^
        lai-inpainting:stable ^
        python -c "
import sys; sys.path.append('/app/scripts');
try:
    from inpainting_api import app;
    import uvicorn;
    uvicorn.run(app, host='0.0.0.0', port=8000)
except ImportError:
    print('inpainting_api.py not found. Please ensure it is in python_scripts/');
    exit(1)
"
) else if "%choice%"=="5" (
    echo Checking dependency compatibility...
    python check_dependencies.py
) else (
    echo Invalid choice. Exiting.
)

if not "%choice%"=="5" (
    echo.
    echo Available images:
    docker images | findstr lai-inpainting
    echo.
    echo To build the image first:
    echo   build_inpainting_docker.bat
)

pause