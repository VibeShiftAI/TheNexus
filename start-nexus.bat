@echo off
setlocal EnableDelayedExpansion

echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║           THE NEXUS - Full Stack Startup              ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.

:: Configuration - uses script's own directory as project root
set "NEXUS_HOME=%~dp0"
:: Remove trailing backslash if present
if "%NEXUS_HOME:~-1%"=="\" set "NEXUS_HOME=%NEXUS_HOME:~0,-1%"
set "NEXUS_BUILDER=%NEXUS_HOME%\nexus-builder"
set "DASHBOARD_DIR=%NEXUS_HOME%\dashboard"
set "TUNNEL_NAME=your-tunnel-name"

:: Change to project root
cd /d "%NEXUS_HOME%"

:: ═══════════════════════════════════════════════════════════════
:: 1. CLOUDFLARE TUNNEL (Routes external traffic)
:: ═══════════════════════════════════════════════════════════════
echo [1/4] Starting Cloudflare Tunnel...
start "Cloudflare Tunnel" /min cmd /k "title Cloudflare Tunnel && cloudflared tunnel --config %NEXUS_HOME%\cloudflared_config.yml run %TUNNEL_NAME%"

:: ═══════════════════════════════════════════════════════════════
:: 2. PYTHON LANGGRAPH ENGINE (Port 8000)
:: ═══════════════════════════════════════════════════════════════
echo [2/4] Starting Python LangGraph Engine (port 8000)...
start "LangGraph (8000)" cmd /k "title LangGraph Engine && cd /d %NEXUS_BUILDER% && call .\venv\Scripts\activate.bat && set PYTHONPATH=%NEXUS_HOME%;%%PYTHONPATH%% && python run.py"

:: Brief wait for Python to start listening
timeout /t 2 /nobreak > nul

:: ═══════════════════════════════════════════════════════════════
:: 3. NODE.JS BACKEND (Port 4000)
:: ═══════════════════════════════════════════════════════════════
echo [3/4] Starting Node.js Backend (port 4000)...
start "Node Backend (4000)" cmd /k "title Nexus Backend && cd /d %NEXUS_HOME% && node server/server.js"

:: Wait for backend before starting dashboard
timeout /t 2 /nobreak > nul

:: ═══════════════════════════════════════════════════════════════
:: 4. NEXT.JS DASHBOARD (Port 3000)
:: ═══════════════════════════════════════════════════════════════
echo [4/4] Starting Next.js Dashboard (port 3000)...
start "Dashboard (3000)" cmd /k "title Nexus Dashboard && cd /d %DASHBOARD_DIR% && npm run dev"

:: ═══════════════════════════════════════════════════════════════
:: SUMMARY
:: ═══════════════════════════════════════════════════════════════
echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║              Nexus is starting up!                    ║
echo  ╠═══════════════════════════════════════════════════════╣
echo  ║                                                       ║
echo  ║   URLs:                                               ║
echo  ║   - Dashboard:    http://localhost:3000               ║
echo  ║   - Node API:     http://localhost:4000               ║
echo  ║   - LangGraph:    http://localhost:8000               ║
echo  ║                                                       ║
echo  ║   Windows Opened (4):                                 ║
echo  ║   - Cloudflare Tunnel                                 ║
echo  ║   - LangGraph Engine (Python)                         ║
echo  ║   - Node.js Backend                                   ║
echo  ║   - Next.js Dashboard                                 ║
echo  ║                                                       ║
echo  ║   Press Ctrl+C in each window to stop services.       ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.
echo Startup complete! This window can be closed.
echo.
pause
