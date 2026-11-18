@echo off
title Moonlight PC Test Environment
cd /d "%~dp0"

echo ========================================================
echo  Launching Moonlight PC Virtual Test Environment...
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js to run the local testing server.
    pause
    exit /b 1
)

echo Starting test server on http://localhost:8080...
start "" http://localhost:8080

node server.js

pause
