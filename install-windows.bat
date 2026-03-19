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
echo  [1/5] Checking prerequisites...
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

:: --- Python ---
set "PYTHON_CMD="
set "NEED_PYTHON=0"
where python >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
) else (
    where python3 >nul 2>nul
    if not errorlevel 1 (
        set "PYTHON_CMD=python3"
    )
)

if "!PYTHON_CMD!"=="" (
    set "NEED_PYTHON=1"
) else (
    for /f "tokens=2" %%v in ('!PYTHON_CMD! --version 2^>nul') do set "PY_VER=%%v"
    for /f "tokens=1,2 delims=." %%a in ("!PY_VER!") do (
        set "PY_MAJOR=%%a"
        set "PY_MINOR=%%b"
    )
    if !PY_MAJOR! LSS 3 (
        echo    ✗ python !PY_VER! found, but 3.10+ is required
        set "NEED_PYTHON=1"
    ) else if !PY_MAJOR! EQU 3 if !PY_MINOR! LSS 10 (
        echo    ✗ python !PY_VER! found, but 3.10+ is required
        set "NEED_PYTHON=1"
    ) else (
        echo    ✓ python !PY_VER!
    )
)

if !NEED_PYTHON!==1 (
    if !HAS_WINGET!==1 (
        set /p "INSTALL_PYTHON=    Install Python 3.12 automatically? [Y/n]: "
        if /i "!INSTALL_PYTHON!"=="" set "INSTALL_PYTHON=Y"
        if /i "!INSTALL_PYTHON!"=="Y" (
            echo    Installing Python via winget...
            winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements -e
            if errorlevel 1 (
                echo    ✗ Failed to install Python. Install manually: https://www.python.org/downloads/
                set /a ERRORS+=1
            ) else (
                echo    ✓ Python installed successfully
                set "PYTHON_CMD=python"
                set "NEEDS_PATH_REFRESH=1"
            )
        ) else (
            echo      Download: https://www.python.org/downloads/
            set /a ERRORS+=1
        )
    ) else (
        echo    ✗ python is NOT installed
        echo      Download: https://www.python.org/downloads/
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
echo  [2/5] Installing Node.js backend dependencies...
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
echo  [3/5] Installing Dashboard dependencies...
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
:: 4. SET UP PYTHON VIRTUAL ENVIRONMENT
:: ═══════════════════════════════════════════════════════════════
echo  [4/5] Setting up Python environment...
cd /d "%NEXUS_DIR%\nexus-builder"

if not exist "venv" (
    echo    Creating virtual environment...
    !PYTHON_CMD! -m venv venv
    if errorlevel 1 (
        echo    ✗ Failed to create Python virtual environment
        pause
        exit /b 1
    )
)

echo    Installing Python packages (this may take a minute)...
call venv\Scripts\activate.bat
pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo    ✗ pip install failed
    pause
    exit /b 1
)
echo    ✓ Python environment ready
echo.

:: ═══════════════════════════════════════════════════════════════
:: 5. CREATE CONFIGURATION FILES
:: ═══════════════════════════════════════════════════════════════
echo  [5/5] Setting up configuration files...
cd /d "%NEXUS_DIR%"

:: Root .env
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo    ✓ Created .env (from .env.example)
) else (
    echo    • .env already exists, skipping
)

:: Python .env
if not exist "nexus-builder\.env" (
    copy "nexus-builder\.env.example" "nexus-builder\.env" >nul
    echo    ✓ Created nexus-builder/.env (from .env.example)
) else (
    echo    • nexus-builder/.env already exists, skipping
)

:: Startup script
if not exist "start-local.bat" (
    copy "start-local.example.bat" "start-local.bat" >nul
    echo    ✓ Created start-local.bat (from example)
) else (
    echo    • start-local.bat already exists, skipping
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
echo  ║      start-local.bat                                  ║
echo  ║                                                       ║
echo  ║   URLs (after startup):                               ║
echo  ║   - Dashboard:  http://localhost:3000                  ║
echo  ║   - Node API:   http://localhost:4000                  ║
echo  ║   - LangGraph:  http://localhost:8000                  ║
echo  ║                                                       ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.
pause
