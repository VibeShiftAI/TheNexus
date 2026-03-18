@echo off
:: Quick local development startup (no Cloudflare tunnel)
:: Faster startup for local-only development

echo.
echo  ===============================================
echo    THE NEXUS - Local Development Startup
echo  ===============================================
echo.

set "NEXUS_DIR=%~dp0"
:: Remove trailing backslash if present
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

:: Wait a moment to ensure previous processes are fully stopped
timeout /t 1 /nobreak > nul

:: Start Python LangGraph
echo [1/3] Starting LangGraph Engine (port 8000)...
start "LangGraph Engine (8000)" cmd /k "cd /d %NEXUS_DIR%\nexus-builder && call .\venv\Scripts\activate.bat && set PYTHONPATH=%NEXUS_DIR%;%%PYTHONPATH%% && uvicorn main:app --reload --port 8000"

:: Brief wait for Python to start listening
timeout /t 1 /nobreak > nul

:: Start Node.js Backend
echo [2/3] Starting Node.js Backend (port 4000)...
start "Nexus Backend (4000)" cmd /k "cd /d %NEXUS_DIR% && node server/server.js"

:: Wait for Node to initialize
timeout /t 2 /nobreak > nul

:: Start Dashboard
echo [3/3] Starting Dashboard (port 3000)...
start "Nexus Dashboard (3000)" cmd /k "cd /d %NEXUS_DIR%\dashboard && npm run dev"

echo.
echo  ===============================================
echo    Nexus is starting up!
echo  ===============================================
echo.
echo    URLs:
echo    - Dashboard:    http://localhost:3000
echo    - Node API:     http://localhost:4000
echo    - LangGraph:    http://localhost:8000
echo.
echo    Terminals:
echo    - LangGraph Engine (8000) = Python backend
echo    - Nexus Backend (4000)    = Node.js API [CHECK THIS FOR ERRORS]
echo    - Nexus Dashboard (3000)  = Next.js frontend
echo.
echo    Close those windows to stop services.
echo    Or run: stop-nexus.bat
echo.
