@echo off
setlocal
cd /d "%~dp0"
if not exist "release\win-unpacked\Terra Board.exe" (
  echo Build the app first with npm run package.
  pause
  exit /b 1
)
set "CANVAS_DATA_DIR=%~dp0Library"
set "ELECTRON_RUN_AS_NODE="
set "CANVAS_DEV_URL="
start "" "%~dp0release\win-unpacked\Terra Board.exe"
