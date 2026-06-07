@echo off
echo ========================================
echo Backend Status Check
echo ========================================
echo.

cd /d %~dp0

echo [1] Checking Docker Compose Services Status:
echo.
docker-compose ps
echo.

echo [2] Checking Backend Logs (last 50 lines):
echo.
docker-compose logs backend --tail=50
echo.

echo [3] Checking Database Logs (last 20 lines):
echo.
docker-compose logs db --tail=20
echo.

echo [4] Checking Redis Logs (last 20 lines):
echo.
docker-compose logs redis --tail=20
echo.

echo [5] Testing Backend Health Endpoint:
echo.
curl -v http://localhost:9999/health-check
echo.

echo [6] Checking Container Resource Usage:
echo.
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" $(docker-compose ps -q)
echo.

echo ========================================
echo Diagnostic Complete
echo ========================================
pause
