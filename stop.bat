@echo off
REM Stop the openrouter-autologin bot (node + bot's Chrome profile).
REM Double-click this file any time the bot needs to be stopped.
title Stop OpenRouter Bot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
pause
