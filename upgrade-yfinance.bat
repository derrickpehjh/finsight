@echo off
title FinSight - Upgrade yfinance in running container
echo ============================================
echo  Upgrading yfinance to 0.2.54 in the
echo  running backend container (no full rebuild)
echo ============================================
echo.
docker exec finsight-backend-1 pip install "yfinance==0.2.54" --quiet
echo.
echo Done! Restarting uvicorn...
docker exec finsight-backend-1 kill -HUP 1 2>nul || echo (Note: uvicorn --reload will pick up changes automatically)
echo.
echo yfinance upgraded. Prices should populate within 5 minutes
echo (after Redis cache expires). Check localhost:3000
pause
