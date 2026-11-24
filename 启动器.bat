@echo off
rem Double-click to open 黑箱剧场 (no console window stays open).
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run:  npm install   inside this folder.
  pause
  exit /b 1
)
if not exist "ui\dist\index.html" (
  echo The page is not built yet. Run:  npm run build   inside this folder.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
