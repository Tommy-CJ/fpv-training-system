@echo off
setlocal
title FPV Virtual Receiver Array
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-virtual-receiver.ps1"
echo.
echo Press any key to close...
pause >nul
