#!/bin/bash
# LangGraph Engine Startup Script for Linux/Mac

echo "═══════════════════════════════════════════════════════"
echo "  TheNexus LangGraph Engine Setup"
echo "═══════════════════════════════════════════════════════"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to create virtual environment"
        echo "Make sure Python 3.10+ is installed"
        exit 1
    fi
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt --quiet

# Check for .env file
if [ ! -f ".env" ]; then
    echo "WARNING: No .env file found"
    echo "Copy .env.example to .env and configure your settings"
fi

# Start the server
echo ""
echo "Starting LangGraph Engine on http://localhost:8000"
echo "Press Ctrl+C to stop"
echo ""
uvicorn main:app --reload --host 0.0.0.0 --port 8000
