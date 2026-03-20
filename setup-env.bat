@echo off
setlocal EnableDelayedExpansion

:: ═══════════════════════════════════════════════════════════════
::  THE NEXUS — Environment Configuration
::  Sets API keys in both .env and nexus-builder/.env
:: ═══════════════════════════════════════════════════════════════

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"

set "ROOT_ENV=%NEXUS_DIR%\.env"
set "PYTHON_ENV=%NEXUS_DIR%\nexus-builder\.env"

echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║        THE NEXUS — Environment Setup                  ║
echo  ╠═══════════════════════════════════════════════════════╣
echo  ║  This will configure your API keys.                   ║
echo  ║  Press ENTER to keep the current value (shown in      ║
echo  ║  brackets). API keys are written to both .env files.  ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.

:: Ensure .env files exist
if not exist "%ROOT_ENV%" (
    if exist "%NEXUS_DIR%\.env.example" (
        copy "%NEXUS_DIR%\.env.example" "%ROOT_ENV%" >nul
        echo  Created .env from .env.example
    ) else (
        echo  ERROR: .env.example not found. Run the installer first.
        pause
        exit /b 1
    )
)
if not exist "%PYTHON_ENV%" (
    if exist "%NEXUS_DIR%\nexus-builder\.env.example" (
        copy "%NEXUS_DIR%\nexus-builder\.env.example" "%PYTHON_ENV%" >nul
        echo  Created nexus-builder/.env from .env.example
    )
)

:: ── Read current values ──────────────────────────────────────

set "CUR_PROJECT_ROOT="
set "CUR_GOOGLE_API_KEY="
set "CUR_OPENAI_API_KEY="
set "CUR_ANTHROPIC_API_KEY="
set "CUR_XAI_API_KEY="

for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT_ENV%") do (
    set "LINE=%%a"
    if not "!LINE:~0,1!"=="#" (
        if "%%a"=="PROJECT_ROOT" set "CUR_PROJECT_ROOT=%%b"
        if "%%a"=="GOOGLE_API_KEY" set "CUR_GOOGLE_API_KEY=%%b"
        if "%%a"=="OPENAI_API_KEY" set "CUR_OPENAI_API_KEY=%%b"
        if "%%a"=="ANTHROPIC_API_KEY" set "CUR_ANTHROPIC_API_KEY=%%b"
        if "%%a"=="XAI_API_KEY" set "CUR_XAI_API_KEY=%%b"
    )
)

:: ── Prompt for values ────────────────────────────────────────

echo  ── Project Root ──────────────────────────────────────
echo  The folder containing your coding projects.
if defined CUR_PROJECT_ROOT (
    set /p "NEW_PROJECT_ROOT=  PROJECT_ROOT [!CUR_PROJECT_ROOT!]: "
) else (
    set /p "NEW_PROJECT_ROOT=  PROJECT_ROOT: "
)
if "!NEW_PROJECT_ROOT!"=="" set "NEW_PROJECT_ROOT=!CUR_PROJECT_ROOT!"
echo.

echo  ── API Keys (at least one required) ──────────────────
echo.

if defined CUR_GOOGLE_API_KEY (
    set /p "NEW_GOOGLE=  GOOGLE_API_KEY [!CUR_GOOGLE_API_KEY!]: "
) else (
    set /p "NEW_GOOGLE=  GOOGLE_API_KEY: "
)
if "!NEW_GOOGLE!"=="" set "NEW_GOOGLE=!CUR_GOOGLE_API_KEY!"

if defined CUR_ANTHROPIC_API_KEY (
    set /p "NEW_ANTHROPIC=  ANTHROPIC_API_KEY [!CUR_ANTHROPIC_API_KEY!]: "
) else (
    set /p "NEW_ANTHROPIC=  ANTHROPIC_API_KEY: "
)
if "!NEW_ANTHROPIC!"=="" set "NEW_ANTHROPIC=!CUR_ANTHROPIC_API_KEY!"

if defined CUR_OPENAI_API_KEY (
    set /p "NEW_OPENAI=  OPENAI_API_KEY [!CUR_OPENAI_API_KEY!]: "
) else (
    set /p "NEW_OPENAI=  OPENAI_API_KEY: "
)
if "!NEW_OPENAI!"=="" set "NEW_OPENAI=!CUR_OPENAI_API_KEY!"

if defined CUR_XAI_API_KEY (
    set /p "NEW_XAI=  XAI_API_KEY [!CUR_XAI_API_KEY!]: "
) else (
    set /p "NEW_XAI=  XAI_API_KEY: "
)
if "!NEW_XAI!"=="" set "NEW_XAI=!CUR_XAI_API_KEY!"

echo.

:: ── Write root .env ──────────────────────────────────────────

echo  Writing .env ...

(
    echo # ==============================================================================
    echo # TheNexus Environment Variables
    echo # ==============================================================================
    echo.
    echo # --- Server ---
    echo PORT=4000
    echo PROJECT_ROOT=!NEW_PROJECT_ROOT!
    echo.
    echo # --- AI Provider API Keys ---
    echo GOOGLE_API_KEY=!NEW_GOOGLE!
    echo OPENAI_API_KEY=!NEW_OPENAI!
    echo ANTHROPIC_API_KEY=!NEW_ANTHROPIC!
    echo XAI_API_KEY=!NEW_XAI!
    echo.
    echo # --- Frontend URLs ---
    echo NEXT_PUBLIC_API_URL=http://localhost:4000
    echo NEXT_PUBLIC_CORTEX_URL=http://localhost:8000
) > "%ROOT_ENV%"

echo    ✓ .env updated

:: ── Write nexus-builder .env ─────────────────────────────────

echo  Writing nexus-builder/.env ...

(
    echo # ==============================================================================
    echo # LangGraph Engine Environment Variables
    echo # ==============================================================================
    echo.
    echo # AI Provider API Keys
    echo GOOGLE_API_KEY=!NEW_GOOGLE!
    echo ANTHROPIC_API_KEY=!NEW_ANTHROPIC!
    echo OPENAI_API_KEY=!NEW_OPENAI!
    echo.
    echo # Node.js backend URL ^(for proxying requests^)
    echo NODEJS_BACKEND_URL=http://localhost:4000
) > "%PYTHON_ENV%"

echo    ✓ nexus-builder/.env updated

echo.
echo  ╔═══════════════════════════════════════════════════════╗
echo  ║         Configuration saved!                          ║
echo  ║                                                       ║
echo  ║   Run "Start The Nexus.bat" to start The Nexus.       ║
echo  ╚═══════════════════════════════════════════════════════╝
echo.
pause
