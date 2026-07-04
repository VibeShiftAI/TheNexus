@echo off
setlocal EnableDelayedExpansion

echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║          THE NEXUS - Windows Installer                ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"
set "ERRORS=0"

:: ═══════════════════════════════════════════════════════════════
:: 1. CHECK & INSTALL PREREQUISITES
:: ═══════════════════════════════════════════════════════════════
echo  [1/4] Checking prerequisites...
echo.

:: Check if winget is available (for auto-install)
set "HAS_WINGET=0"
where winget >nul 2>nul
if not errorlevel 1 set "HAS_WINGET=1"

:: --- Git ---
where git >nul 2>nul
if errorlevel 1 (
    echo    ✗ git is not installed
    if !HAS_WINGET!==1 (
        set /p "INSTALL_GIT=    Install git automatically? [Y/n]: "
        if /i "!INSTALL_GIT!"=="" set "INSTALL_GIT=Y"
        if /i "!INSTALL_GIT!"=="Y" (
            echo    Installing git via winget...
            winget install Git.Git --accept-package-agreements --accept-source-agreements -e
            if errorlevel 1 (
                echo    ✗ Failed to install git. Install manually: https://git-scm.com/downloads
                set /a ERRORS+=1
            ) else (
                echo    ✓ git installed successfully
                set "NEEDS_PATH_REFRESH=1"
            )
        ) else (
            echo      Download: https://git-scm.com/downloads
            set /a ERRORS+=1
        )
    ) else (
        echo      Download: https://git-scm.com/downloads
        set /a ERRORS+=1
    )
) else (
    for /f "tokens=3" %%v in ('git --version 2^>nul') do echo    ✓ git %%v
)

:: --- Node.js ---
set "NEED_NODE=0"
where node >nul 2>nul
if errorlevel 1 (
    set "NEED_NODE=1"
) else (
    for /f "tokens=1 delims=v" %%v in ('node -v 2^>nul') do set "NODE_RAW=%%v"
    for /f "tokens=1 delims=v." %%m in ('node -v 2^>nul') do set "NODE_MAJOR=%%m"
    set "NODE_MAJOR=!NODE_MAJOR:v=!"
    if !NODE_MAJOR! LSS 18 (
        echo    ✗ node v!NODE_RAW! found, but v18+ is required
        set "NEED_NODE=1"
    ) else (
        echo    ✓ node !NODE_RAW!
    )
)

if !NEED_NODE!==1 (
    if !HAS_WINGET!==1 (
        set /p "INSTALL_NODE=    Install Node.js 22 LTS automatically? [Y/n]: "
        if /i "!INSTALL_NODE!"=="" set "INSTALL_NODE=Y"
        if /i "!INSTALL_NODE!"=="Y" (
            echo    Installing Node.js via winget...
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements -e
            if errorlevel 1 (
                echo    ✗ Failed to install Node.js. Install manually: https://nodejs.org/
                set /a ERRORS+=1
            ) else (
                echo    ✓ Node.js installed successfully
                set "NEEDS_PATH_REFRESH=1"
            )
        ) else (
            echo      Download: https://nodejs.org/
            set /a ERRORS+=1
        )
    ) else (
        echo    ✗ node is NOT installed
        echo      Download: https://nodejs.org/
        set /a ERRORS+=1
    )
)

:: --- Refresh PATH if we installed anything ---
if defined NEEDS_PATH_REFRESH (
    echo.
    echo    Refreshing PATH to detect newly installed tools...
    :: Pull updated Machine and User PATH from registry
    for /f "tokens=2,*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
    for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%b"
    set "PATH=!SYS_PATH!;!USR_PATH!"
)

:: --- npm (re-check after potential Node.js install) ---
where npm >nul 2>nul
if errorlevel 1 (
    echo    ✗ npm is NOT available (comes with Node.js)
    set /a ERRORS+=1
) else (
    for /f %%v in ('npm -v 2^>nul') do echo    ✓ npm %%v
)

echo.

if !ERRORS! GTR 0 (
    echo  ╔═══════════════════════════════════════════════════════╗
    echo  ║   !ERRORS! prerequisite(s) still missing. Install and retry.  ║
    echo  ╚═══════════════════════════════════════════════════════╝
    echo.
    pause
    exit /b 1
)

echo    All prerequisites found!
echo.

:: ═══════════════════════════════════════════════════════════════
:: 2. INSTALL NODE.JS DEPENDENCIES (root)
:: ═══════════════════════════════════════════════════════════════
echo  [2/4] Installing Node.js backend dependencies...
cd /d "%NEXUS_DIR%"
call npm install
if errorlevel 1 (
    echo    ✗ npm install failed in project root
    pause
    exit /b 1
)
echo    ✓ Backend dependencies installed
echo.

:: ═══════════════════════════════════════════════════════════════
:: 3. INSTALL DASHBOARD DEPENDENCIES
:: ═══════════════════════════════════════════════════════════════
echo  [3/4] Installing Dashboard dependencies...
cd /d "%NEXUS_DIR%\dashboard"
call npm install
if errorlevel 1 (
    echo    ✗ npm install failed in dashboard/
    pause
    exit /b 1
)
echo    ✓ Dashboard dependencies installed
echo.

:: ═══════════════════════════════════════════════════════════════
:: 4. CREATE CONFIGURATION FILES
:: ═══════════════════════════════════════════════════════════════
echo  [4/4] Setting up configuration files...
cd /d "%NEXUS_DIR%"

:: Root .env
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo    ✓ Created .env (from .env.example)
) else (
    echo    • .env already exists, skipping
)

:: Startup script
if not exist "Start The Nexus.bat" (
    copy "Start The Nexus.example.bat" "Start The Nexus.bat" >nul
    echo    ✓ Created "Start The Nexus.bat" (from example)
) else (
    echo    • "Start The Nexus.bat" already exists, skipping
)

echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║            Installation Complete!                     ║
echo  ╠═══════════════════════════════════════════════════════╣
echo  ║                                                       ║
echo  ║   Next steps:                                         ║
echo  ║                                                       ║
echo  ║   1. Edit .env with your API keys:                    ║
echo  ║      notepad .env                                     ║
echo  ║                                                       ║
echo  ║   2. Start The Nexus:                                 ║
echo  ║      "Start The Nexus.bat"                            ║
echo  ║                                                       ║
echo  ║   URLs (after startup):                               ║
echo  ║   - Dashboard:  http://localhost:3000                  ║
echo  ║   - Node API:   http://localhost:4000                  ║
echo  ║                                                       ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.
pause
