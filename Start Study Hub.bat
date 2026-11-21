@echo off
rem Double-click this file to start Study Hub on Windows.
title Study Hub
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Study Hub needs Node.js, which is not installed yet.
  echo Your browser will open the download page. Install the "LTS" version,
  echo then double-click "Start Study Hub" again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo Study Hub needs Node.js 18 or newer. Please install the latest "LTS" version from nodejs.org.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
echo Starting Study Hub... your browser will open in a moment.
node server.js --open
echo.
echo Study Hub has stopped.
pause
