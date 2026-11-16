@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ZQQ-harness Web UI
echo Starting ZQQ-harness ...  (browser will open automatically; port: see server output below)
call npm run desktop
echo.
echo Server stopped. You can close this window.
pause >nul
