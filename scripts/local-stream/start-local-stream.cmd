@echo off
REM Windows launcher for start-local-stream.ps1 (Docker Desktop + Mentra Live hotspot).
REM Double-click or run from cmd:
REM   scripts\local-stream\start-local-stream.cmd
REM Optional:
REM   set LAN_IP=192.168.43.81
REM   scripts\local-stream\start-local-stream.cmd
REM
REM If double-clicked and something fails, we pause so the window does not
REM vanish before you can read the error.

setlocal
cd /d "%~dp0"
set "ERR=0"

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: docker not found. Start Docker Desktop, wait until it is running, then retry.
  set "ERR=1"
  goto :end
)

REM Prefer Windows PowerShell; -File avoids some parse quirks vs piping.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-stream.ps1" %*
set "ERR=%ERRORLEVEL%"

:end
if not "%ERR%"=="0" (
  echo.
  echo ========================================================
  echo FAILED with exit code %ERR%.
  echo Keep this window open, read the error above, then press a key.
  echo ========================================================
  pause
)
endlocal & exit /b %ERR%
