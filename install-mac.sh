#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  THE NEXUS — macOS / Linux Installer
# ═══════════════════════════════════════════════════════════════

set -e

NEXUS_DIR="$(cd "$(dirname "$0")" && pwd)"
ERRORS=0

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║          THE NEXUS — macOS / Linux Installer          ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════════
# 1. CHECK PREREQUISITES
# ═══════════════════════════════════════════════════════════════
echo "  [1/5] Checking prerequisites..."
echo ""

# --- Git ---
if command -v git &>/dev/null; then
    echo "    ✓ git $(git --version | awk '{print $3}')"
else
    echo "    ✗ git is NOT installed"
    echo "      Install: https://git-scm.com/downloads or 'xcode-select --install'"
    ERRORS=$((ERRORS + 1))
fi

# --- Node.js ---
if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo "    ✗ node v${NODE_VER} found, but v18+ is required"
        echo "      Download: https://nodejs.org/"
        ERRORS=$((ERRORS + 1))
    else
        echo "    ✓ node v${NODE_VER}"
    fi
else
    echo "    ✗ node is NOT installed"
    echo "      Download: https://nodejs.org/"
    ERRORS=$((ERRORS + 1))
fi

# --- npm ---
if command -v npm &>/dev/null; then
    echo "    ✓ npm $(npm -v)"
else
    echo "    ✗ npm is NOT installed (comes with Node.js)"
    ERRORS=$((ERRORS + 1))
fi

# --- Python ---
PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
fi

if [ -z "$PYTHON_CMD" ]; then
    echo "    ✗ python3 is NOT installed"
    echo "      Download: https://www.python.org/downloads/"
    ERRORS=$((ERRORS + 1))
else
    PY_VER=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
        echo "    ✗ python ${PY_VER} found, but 3.10+ is required"
        echo "      Download: https://www.python.org/downloads/"
        ERRORS=$((ERRORS + 1))
    else
        echo "    ✓ python ${PY_VER}"
    fi
fi

echo ""

if [ "$ERRORS" -gt 0 ]; then
    echo "  ╔═══════════════════════════════════════════════════════╗"
    echo "  ║   ${ERRORS} missing prerequisite(s). Install them and retry.  ║"
    echo "  ╚═══════════════════════════════════════════════════════╝"
    echo ""
    exit 1
fi

echo "    All prerequisites found!"
echo ""

# ═══════════════════════════════════════════════════════════════
# 2. INSTALL NODE.JS DEPENDENCIES (root)
# ═══════════════════════════════════════════════════════════════
echo "  [2/5] Installing Node.js backend dependencies..."
cd "$NEXUS_DIR"
npm install
echo "    ✓ Backend dependencies installed"
echo ""

# ═══════════════════════════════════════════════════════════════
# 3. INSTALL DASHBOARD DEPENDENCIES
# ═══════════════════════════════════════════════════════════════
echo "  [3/5] Installing Dashboard dependencies..."
cd "$NEXUS_DIR/dashboard"
npm install
echo "    ✓ Dashboard dependencies installed"
echo ""

# ═══════════════════════════════════════════════════════════════
# 4. SET UP PYTHON VIRTUAL ENVIRONMENT
# ═══════════════════════════════════════════════════════════════
echo "  [4/5] Setting up Python environment..."
cd "$NEXUS_DIR/nexus-builder"

if [ ! -d "venv" ]; then
    echo "    Creating virtual environment..."
    $PYTHON_CMD -m venv venv
fi

echo "    Installing Python packages (this may take a minute)..."
source venv/bin/activate
pip install -r requirements.txt --quiet
echo "    ✓ Python environment ready"
echo ""

# ═══════════════════════════════════════════════════════════════
# 5. CREATE CONFIGURATION FILES
# ═══════════════════════════════════════════════════════════════
echo "  [5/5] Setting up configuration files..."
cd "$NEXUS_DIR"

# Root .env
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "    ✓ Created .env (from .env.example)"
else
    echo "    • .env already exists, skipping"
fi

# Python .env
if [ ! -f "nexus-builder/.env" ]; then
    cp nexus-builder/.env.example nexus-builder/.env
    echo "    ✓ Created nexus-builder/.env (from .env.example)"
else
    echo "    • nexus-builder/.env already exists, skipping"
fi

# Startup script
if [ ! -f "start-local.sh" ]; then
    cp start-local.example.sh start-local.sh
    echo "    ✓ Created start-local.sh (from example)"
else
    echo "    • start-local.sh already exists, skipping"
fi

# Stop script
if [ ! -f "stop-nexus.sh" ]; then
    cp stop-nexus.example.sh stop-nexus.sh 2>/dev/null || true
    echo "    ✓ Created stop-nexus.sh"
fi

# Make scripts executable
chmod +x start-local.sh stop-nexus.sh start-local.example.sh stop-nexus.example.sh 2>/dev/null || true

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║            Installation Complete!                     ║"
echo "  ╠═══════════════════════════════════════════════════════╣"
echo "  ║                                                       ║"
echo "  ║   Next steps:                                         ║"
echo "  ║                                                       ║"
echo "  ║   1. Edit .env with your API keys:                    ║"
echo "  ║      nano .env                                        ║"
echo "  ║                                                       ║"
echo "  ║   2. Start The Nexus:                                 ║"
echo "  ║      ./start-local.sh                                 ║"
echo "  ║                                                       ║"
echo "  ║   URLs (after startup):                               ║"
echo "  ║   - Dashboard:  http://localhost:3000                  ║"
echo "  ║   - Node API:   http://localhost:4000                  ║"
echo "  ║   - LangGraph:  http://localhost:8000                  ║"
echo "  ║                                                       ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""
