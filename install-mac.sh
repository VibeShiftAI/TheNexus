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
echo "  [1/4] Checking prerequisites..."
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

# --- ripgrep (rg) ---
if command -v rg &>/dev/null; then
    echo "    ✓ ripgrep $(rg --version | head -1 | awk '{print $2}')"
else
    echo "    ✗ ripgrep (rg) is not installed"
    INSTALLED=false
    if $IS_MAC && $HAS_BREW; then
        if confirm "Install ripgrep via Homebrew?"; then
            brew install ripgrep && INSTALLED=true
        fi
    elif $IS_LINUX && $HAS_APT; then
        if confirm "Install ripgrep via apt?"; then
            sudo apt update -qq && sudo apt install -y ripgrep && INSTALLED=true
        fi
    fi
    if $INSTALLED; then
        echo "    ✓ ripgrep installed successfully"
    else
        echo "      Install manually: https://github.com/BurntSushi/ripgrep#installation"
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
echo "  [2/4] Installing Node.js backend dependencies..."
cd "$NEXUS_DIR"
npm install
echo "    ✓ Backend dependencies installed"
echo ""

# ═══════════════════════════════════════════════════════════════
# 3. INSTALL DASHBOARD DEPENDENCIES
# ═══════════════════════════════════════════════════════════════
echo "  [3/4] Installing Dashboard dependencies..."
cd "$NEXUS_DIR/dashboard"
npm install
echo "    ✓ Dashboard dependencies installed"
echo ""

# ═══════════════════════════════════════════════════════════════
# 4. CREATE CONFIGURATION FILES
# ═══════════════════════════════════════════════════════════════
echo "  [4/4] Setting up configuration files..."
cd "$NEXUS_DIR"

# Root .env
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "    ✓ Created .env (from .env.example)"
else
    echo "    • .env already exists, skipping"
fi

# Startup script (shell)
if [ ! -f "start-local.sh" ]; then
    cp start-local.example.sh start-local.sh
    echo "    ✓ Created start-local.sh (from example)"
else
    echo "    • start-local.sh already exists, skipping"
fi

# Startup script (macOS double-click)
if [ ! -f "Start The Nexus.command" ]; then
    cp "Start The Nexus.example.command" "Start The Nexus.command" 2>/dev/null || true
    echo '    ✓ Created "Start The Nexus.command" (from example)'
else
    echo '    • "Start The Nexus.command" already exists, skipping'
fi

# Stop script
if [ ! -f "stop-nexus.sh" ]; then
    cp stop-nexus.example.sh stop-nexus.sh 2>/dev/null || true
    echo "    ✓ Created stop-nexus.sh"
fi

# Make scripts executable
chmod +x start-local.sh stop-nexus.sh start-local.example.sh stop-nexus.example.sh "Start The Nexus.command" "Start The Nexus.example.command" 2>/dev/null || true

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
echo "  ║      Double-click \"Start The Nexus.command\"           ║"
echo "  ║      or run: ./start-local.sh                          ║"
echo "  ║                                                       ║"
echo "  ║   URLs (after startup):                               ║"
echo "  ║   - Dashboard:  http://localhost:3000                  ║"
echo "  ║   - Node API:   http://localhost:4000                  ║"
echo "  ║                                                       ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""
