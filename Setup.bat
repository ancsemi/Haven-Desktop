@echo off
title Haven Desktop — Setup
color 0D
echo.
echo  =============================================
echo   Haven Desktop — First-Time Setup
echo  =============================================
echo.

cd /d "%~dp0"

:: ─── Check Node.js ─────────────────────────────────────
echo [1/4] Checking for Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo  ERROR: Node.js is not installed or not in PATH.
    echo  Download it from: https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo        Found Node.js %%v

:: ─── Install npm dependencies ──────────────────────────
echo.
echo [2/4] Installing dependencies (this may take a minute)...
echo.
call npm install --ignore-scripts
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo  ERROR: npm install failed. Check the output above.
    pause
    exit /b 1
)
echo.
echo        Dependencies installed successfully.

:: ─── electron-builder install-app-deps ───────────────
echo.
echo [3/4] Rebuilding native modules for Electron...
echo.
node "./node_modules/electron-builder/out/cli/cli.js" install-app-deps 2>nul
if %ERRORLEVEL% neq 0 (
    echo        install-app-deps skipped (non-critical^)
) else (
    echo        install-app-deps complete.
)

:: ─── Build native media components ─────────────────────
echo.
echo [4/4] Building native media components...
echo        (Requires Visual Studio Build Tools and the GStreamer SDK^)
echo.

:: Use explicit path to node-gyp (avoids npx @ path resolution bug)
node "./node_modules/node-gyp/bin/node-gyp.js" rebuild --directory=native

if exist "native\build\Release\haven_screen_share.exe" (
    call npm run stage:native-runtime
    if errorlevel 1 (
        echo        WARNING: GStreamer runtime staging failed.
        echo        Native GPU screen sharing will be unavailable in dev mode.
    )
)

:: node-gyp sends info to stderr so exit code can be wrong — check the file
if exist "native\build\Release\haven_audio.node" (
    color 0A
    echo.
    echo  [OK] Native audio addon built successfully!
    echo       Per-app audio capture is ENABLED.
    goto :done
)

color 0E
echo.
echo  !! Native audio addon failed to build.
echo  Per-app audio isolation will NOT be available.
echo  The app will still work — just with system audio.
echo.
echo  To fix: install Visual Studio Build Tools 2022
echo  https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo  Select "Desktop development with C++" workload,
echo  then re-run this Setup.

:: ─── Done ──────────────────────────────────────────────
:done
echo.
echo  =============================================
echo   Setup complete!
echo   Run "Start Haven Desktop.bat" to launch.
echo  =============================================
echo.
pause
