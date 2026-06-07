@echo off
echo Building Inpainting Docker Image...
echo.

cd /d "%~dp0"

echo Choose a Dockerfile version:
echo 1. Standard version (dockers\backend\Dockerfile.inpainting.stable) - RECOMMENDED
echo 2. Original version (python_scripts\data\inpainting\Dockerfile)
echo.

set /p choice="Enter your choice (1-2): "

if "%choice%"=="1" (
    echo Building with stable, proven compatible versions...
    docker build -f ..\dockers\backend\Dockerfile.inpainting.stable -t lai-inpainting:stable .
    set image_name=lai-inpainting:stable
) else if "%choice%"=="2" (
    echo Building with original Dockerfile...
    docker build -f python_scripts\data\inpainting\Dockerfile -t lai-inpainting:latest .
    set image_name=lai-inpainting:latest
) else (
    echo Invalid choice. Building stable version by default...
    docker build -f ..\dockers\backend\Dockerfile.inpainting.stable -t lai-inpainting:stable .
    set image_name=lai-inpainting:stable
)

if %errorlevel% equ 0 (
    echo.
    echo ✓ Docker image built successfully!
    echo.
    echo To test the container:
    echo   docker run --gpus all --rm %image_name% python test_dependencies.py
    echo.
    echo To run interactively:
    echo   docker run --gpus all -it --rm -v "%cd%\data:/app/data" %image_name%
    echo.
    echo To run a quick inpainting test:
    echo   docker run --gpus all --rm -v "%cd%\data:/app/data" %image_name% python test_inpainting.py
) else (
    echo.
    echo ✗ Docker build failed!
    echo Check the error messages above.
    echo.
    echo Common fixes:
    echo 1. Ensure Docker is running
    echo 2. Check internet connection for package downloads
    echo 3. Ensure sufficient disk space
    echo 4. Try building the stable version (option 1)
)

pause