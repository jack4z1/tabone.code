@echo off
title Tab Bridge Test Client
echo ====================================================
echo Testing Tab Bridge (Auto-Inject to Browser AI)...
echo ====================================================
cd /d "%~dp0"
node test-client.mjs
echo.
pause
