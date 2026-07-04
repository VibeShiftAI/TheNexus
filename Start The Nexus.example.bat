@echo off
:: Quick local development startup (no Cloudflare tunnel)
:: Faster startup for local-only development

echo.
echo  ===============================================
echo    THE NEXUS - Local Development Startup
echo  ===============================================
echo.

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

timeout /t 1 /nobreak > nul

echo [1/2] Starting Node.js Backend (port 4000)...
start "Nexus Backend (4000)" cmd /k "cd /d %NEXUS_DIR% && node server/server.js"

timeout /t 2 /nobreak > nul

echo [2/2] Starting Dashboard (port 3000)...
start "Nexus Dashboard (3000)" cmd /k "cd /d %NEXUS_DIR%\dashboard && npm run dev"

echo.
echo  ===============================================
echo    Nexus is starting up!
echo  ===============================================
echo.
echo    URLs:
echo    - Dashboard:    http://localhost:3000
echo    - Node API:     http://localhost:4000
echo.
echo    Close those windows to stop services.
echo.
