@echo off
title FinSight Frontend (Next.js)
echo ============================================
echo  FinSight - Starting frontend...
echo  App will be at: http://localhost:3000
echo ============================================
echo.
cd /d "%~dp0frontend"
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
npm run dev
pause
