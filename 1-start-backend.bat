@echo off
title FinSight Backend (Docker)
echo ============================================
echo  FinSight - Starting backend services...
echo  This builds + starts: Postgres, Redis,
echo  Qdrant, Ollama, and the FastAPI backend.
echo  First run: Ollama will download ~5GB of
echo  models (llama3.1:8b + nomic-embed-text).
echo ============================================
echo.
cd /d "%~dp0"
docker compose up --build
pause
