@echo off
title Haven Desktop
cd /d "%~dp0"

:: Quick check that setup has been run
if not exist "node_modules" (
    color 0C
    echo.
    echo  Haven Desktop has not been set up yet.
    echo  Please run "Setup.bat" first.
    echo.
    pause
    exit /b 1
)

:: Give electron.exe the Haven icon and name, so the taskbar and Start Menu
:: show Haven instead of Electron. Does nothing once done, and never stops
:: the launch.
node "./scripts/brand-dev-electron.js"

:: Launch Electron in dev mode
echo Starting Haven Desktop...
node "./node_modules/electron/cli.js" . --dev
