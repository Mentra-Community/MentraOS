@echo off
REM Load offline MediaMTX image. Pauses on failure so double-click errors stay visible.
setlocal
cd /d "%~dp0"
set "ERR=0"

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: docker not found. Start Docker Desktop and retry.
  set "ERR=1"
  goto :end
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0load-images.ps1" %*
set "ERR=%ERRORLEVEL%"

:end
if not "%ERR%"=="0" (
  echo.
  echo FAILED with exit code %ERR%.
  pause
) else (
  echo.
  echo Done. You can close this window.
  pause
)
endlocal & exit /b %ERR%
