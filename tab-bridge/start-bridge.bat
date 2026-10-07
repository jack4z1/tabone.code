@echo off
title Tab Bridge Local Server
echo ====================================================
echo Starting Tab Bridge Server on http://127.0.0.1:4040...
echo Keep this window open while using Tab Bridge.
echo ====================================================
cd /d "%~dp0server"
node dist/index.js
pause
