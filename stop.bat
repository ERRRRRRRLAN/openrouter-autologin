@echo off
REM Stop bot openrouter-autologin (node + Chrome profil bot).
REM Double-click file ini kapan pun bot perlu dihentikan.
title Stop OpenRouter Bot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
pause
