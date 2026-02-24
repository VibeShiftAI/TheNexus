@echo off
REM LangGraph Engine Startup Script for Windows

echo ═══════════════════════════════════════════════════════
echo   TheNexus LangGraph Engine Setup
echo ═══════════════════════════════════════════════════════

REM Check if virtual environment exists
if not exist "venv" (
    echo Creating Python virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment
        echo Make sure Python 3.10+ is installed
        exit /b 1
    )
)

REM Activate virtual environment
echo Activating virtual environment...
call venv\Scripts\activate.bat

REM Install dependencies
echo Installing dependencies...
pip install -r requirements.txt --quiet

REM Check for .env file
if not exist ".env" (
    echo WARNING: No .env file found
    echo Copy .env.example to .env and configure your settings
)

REM Start the server
echo.
echo Starting LangGraph Engine on http://localhost:8000
echo Press Ctrl+C to stop
echo.
uvicorn main:app --reload --host 0.0.0.0 --port 8000 --reload-exclude "dry_run_test*" --reload-exclude "_audit_temp/*"
