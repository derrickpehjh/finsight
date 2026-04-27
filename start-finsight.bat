@echo off
:: Wait for Docker Desktop to be fully ready before starting containers
echo Waiting for Docker to be ready...
:wait_loop
docker info >nul 2>&1
if errorlevel 1 (
    timeout /t 5 /nobreak >nul
    goto wait_loop
)

echo Docker is ready. Starting FinSight containers...
cd /d "%~dp0"
docker compose up -d

echo FinSight containers started.
