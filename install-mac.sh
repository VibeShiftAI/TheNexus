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
# 1. CHECK & INSTALL PREREQUISITES
# ═══════════════════════════════════════════════════════════════
echo "  [1/5] Checking prerequisites..."
echo ""

# Detect platform
IS_MAC=false
IS_LINUX=false
if [[ "$(uname)" == "Darwin" ]]; then
    IS_MAC=true
elif [[ "$(uname)" == "Linux" ]]; then
    IS_LINUX=true
fi

# Helper: prompt Y/n (default Yes)
confirm() {
    read -r -p "    $1 [Y/n]: " response
    [[ -z "$response" || "$response" =~ ^[Yy] ]]
}

# Detect package manager
HAS_BREW=false
HAS_APT=false
if command -v brew &>/dev/null; then
    HAS_BREW=true
elif command -v apt &>/dev/null; then
    HAS_APT=true
fi

# On macOS, offer to install Homebrew if missing
if $IS_MAC && ! $HAS_BREW; then
    echo "    ✗ Homebrew is not installed (recommended for macOS)"
    if confirm "Install Homebrew? (https://brew.sh)"; then
        echo "    Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add Homebrew to PATH for this session
        if [ -f "/opt/homebrew/bin/brew" ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -f "/usr/local/bin/brew" ]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        HAS_BREW=true
        echo "    ✓ Homebrew installed"
    fi
fi

# --- Git ---
if command -v git &>/dev/null; then
    echo "    ✓ git $(git --version | awk '{print $3}')"
else
    echo "    ✗ git is not installed"
    INSTALLED=false
    if $IS_MAC; then
        if confirm "Install git via Homebrew?"; then
            brew install git && INSTALLED=true
        fi
    elif $IS_LINUX && $HAS_APT; then
        if confirm "Install git via apt?"; then
            sudo apt update -qq && sudo apt install -y git && INSTALLED=true
        fi
    fi
    if $INSTALLED; then
        echo "    ✓ git installed successfully"
    else
        echo "      Install manually: https://git-scm.com/downloads"
        ERRORS=$((ERRORS + 1))
    fi
fi

# --- Node.js ---
NEED_NODE=false
if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo "    ✗ node v${NODE_VER} found, but v18+ is required"
        NEED_NODE=true
    else
        echo "    ✓ node v${NODE_VER}"
    fi
else
    NEED_NODE=true
fi

if $NEED_NODE; then
    INSTALLED=false
    if $HAS_BREW; then
        if confirm "Install Node.js LTS via Homebrew?"; then
            brew install node@22 && brew link node@22 --overwrite 2>/dev/null
            INSTALLED=true
        fi
    elif $IS_LINUX && $HAS_APT; then
        if confirm "Install Node.js 22 via NodeSource?"; then
            echo "    Setting up NodeSource repository..."
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
            sudo apt install -y nodejs && INSTALLED=true
        fi
    fi
    if $INSTALLED; then
        echo "    ✓ Node.js installed successfully"
    else
        echo "      Install manually: https://nodejs.org/"
        ERRORS=$((ERRORS + 1))
    fi
fi

# --- npm (re-check after potential Node.js install) ---
if command -v npm &>/dev/null; then
    echo "    ✓ npm $(npm -v)"
else
    echo "    ✗ npm is NOT available (comes with Node.js)"
    ERRORS=$((ERRORS + 1))
fi

# --- Python ---
PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
fi

NEED_PYTHON=false
if [ -z "$PYTHON_CMD" ]; then
    NEED_PYTHON=true
else
    PY_VER=$($PYTHON_CMD --version 2>&1 | awk '{print $2}')
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
        echo "    ✗ python ${PY_VER} found, but 3.10+ is required"
        NEED_PYTHON=true
    else
        echo "    ✓ python ${PY_VER}"
    fi
fi

if $NEED_PYTHON; then
    INSTALLED=false
    if $HAS_BREW; then
        if confirm "Install Python 3.12 via Homebrew?"; then
            brew install python@3.12 && INSTALLED=true
            PYTHON_CMD="python3"
        fi
    elif $IS_LINUX && $HAS_APT; then
        if confirm "Install Python 3.12 via apt?"; then
            sudo apt update -qq && sudo apt install -y python3 python3-venv python3-pip && INSTALLED=true
            PYTHON_CMD="python3"
        fi
    fi
    if $INSTALLED; then
        echo "    ✓ Python installed successfully"
    else
        echo "      Install manually: https://www.python.org/downloads/"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""

if [ "$ERRORS" -gt 0 ]; then
    echo "  ╔═══════════════════════════════════════════════════════╗"
    echo "  ║   ${ERRORS} prerequisite(s) still missing. Install and retry.  ║"
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
