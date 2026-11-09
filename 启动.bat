@echo off
setlocal
cd /d "%~dp0"
title STAYPOINT - Close this window to stop the server
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
set NO_COLOR=1

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found in PATH.
  echo Install Python 3.10+ and try again.
  pause
  exit /b 1
)

python -c "import flask, requests" >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Installing dependencies...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

rem Refuse to start a second copy; otherwise the window would close immediately.
python -c "import socket,sys; s=socket.socket(); s.settimeout(0.3); sys.exit(0 if s.connect_ex(('127.0.0.1', 8765)) == 0 else 1)" >nul 2>nul
if not errorlevel 1 (
  echo [ERROR] Port 8765 is already in use.
  echo Close the other STAYPOINT window first, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting STAYPOINT...
echo Keep this window open while using the app.
echo Close this window to stop the server.
echo.
python -u app.py --port 8765 --open
set "EXITCODE=%ERRORLEVEL%"
echo.
echo Server stopped. Exit code: %EXITCODE%
echo Press any key to close this window.
pause >nul
endlocal
