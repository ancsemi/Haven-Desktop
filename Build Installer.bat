@echo off
title Haven Desktop — Build Installer
color 0B
echo.
echo  =============================================
echo   Haven Desktop — Build Windows Installer
echo  =============================================
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    color 0C
    echo  Run Setup.bat first!
    pause
    exit /b 1
)

echo Building one-click Windows installer...
echo (This will create an .exe in the dist/ folder)
echo.
node "./node_modules/electron-builder/out/cli/cli.js" --win
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo  Build failed. Check the output above.
    pause
    exit /b 1
)

echo.
echo  =============================================
echo   Build complete! Installer is in: dist\
echo  =============================================
echo.
explorer dist
pause
