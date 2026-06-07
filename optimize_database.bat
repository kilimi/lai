@echo off
REM Script to optimize database performance in Docker container
REM Run this from the project root directory

echo 🚀 Optimizing Database Performance in Docker...
echo ==============================================

REM Check if Docker container is running
docker ps | findstr "lai-backend" >nul
if %errorlevel% neq 0 (
    echo ❌ Docker container 'lai-backend' is not running!
    echo Please start the container first with: docker-compose up -d
    exit /b 1
)

echo ✅ Docker container is running

REM Run the database optimization script inside the container
echo 📊 Running database performance analysis and optimization...
docker exec -it lai-backend-1 python add_database_indexes.py

if %errorlevel% equ 0 (
    echo ✅ Database optimization completed successfully!
    echo.
    echo 🏃‍♂️ Performance improvements:
    echo   • Added database indexes for faster annotation queries
    echo   • Optimized compound indexes for common query patterns
    echo   • Analyzed tables for query optimization
    echo.
    echo 📈 Expected improvements:
    echo   • Annotation loading should be 10-100x faster
    echo   • Dataset view should load much quicker
    echo   • Reduced memory usage for large datasets
    echo.
    echo 🔄 Please restart your backend to see the full benefits:
    echo    docker-compose restart backend
) else (
    echo ❌ Database optimization failed!
    echo Check the Docker logs for more details:
    echo    docker logs lai-backend-1
)

pause
