@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZQQ-harness Web UI
echo Starting ZQQ-harness ...  http://localhost:8787  (browser will open automatically)
call npm run web
echo.
echo Server stopped. You can close this window.
pause >nul
