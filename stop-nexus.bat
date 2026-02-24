@echo off
:: Stop all Nexus services by killing processes on their ports
:: Also kills leftover cmd windows that may hold onto processes

echo.
echo ===============================================
echo   Stopping Nexus Services...
echo ===============================================
echo.

:: Kill Node.js processes (this ensures server.js gets terminated)
echo Killing Node.js processes...
taskkill /IM node.exe /F 2>nul && echo   Killed node.exe || echo   No node.exe running

:: Kill Python processes (uvicorn)
echo Killing Python processes...
taskkill /IM python.exe /F 2>nul && echo   Killed python.exe || echo   No python.exe running

:: Kill cloudflared if running
echo Killing Cloudflare tunnel...
taskkill /IM cloudflared.exe /F 2>nul && echo   Killed cloudflared.exe || echo   No cloudflared running

:: Double-check by port (in case process names differ)
echo.
echo Checking ports...

:: Kill process on port 3000 (Dashboard)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    echo   Stopping port 3000 (PID %%a)...
    taskkill /PID %%a /F 2>nul
)

:: Kill process on port 4000 (Node backend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING 2^>nul') do (
    echo   Stopping port 4000 (PID %%a)...
    taskkill /PID %%a /F 2>nul
)

:: Kill process on port 8000 (Python LangGraph)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING 2^>nul') do (
    echo   Stopping port 8000 (PID %%a)...
    taskkill /PID %%a /F 2>nul
)

echo.
echo ===============================================
echo   All services stopped.
echo ===============================================
echo.
timeout /t 2 /nobreak > nul
