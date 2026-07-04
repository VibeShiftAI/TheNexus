#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  THE NEXUS — Local Development Startup
# ═══════════════════════════════════════════════════════════════

NEXUS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ==============================================="
echo "    THE NEXUS - Local Development Startup"
echo "  ==============================================="
echo ""

# ───────────────────────────────────────────────────────────────
# 1. Start Node.js Backend (port 4000)
# ───────────────────────────────────────────────────────────────
echo "  [1/2] Starting Node.js Backend (port 4000)..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "
        tell application "Terminal"
            activate
            do script "cd '$NEXUS_DIR' && node server/server.js"
        end tell
    "
else
    if command -v gnome-terminal &>/dev/null; then
        gnome-terminal --title="Nexus Backend (4000)" -- bash -c "cd '$NEXUS_DIR' && node server/server.js; exec bash"
    elif command -v xterm &>/dev/null; then
        xterm -title "Nexus Backend (4000)" -e "cd '$NEXUS_DIR' && node server/server.js" &
    else
        (cd "$NEXUS_DIR" && node server/server.js) &
    fi
fi

sleep 2

# ───────────────────────────────────────────────────────────────
# 2. Start Dashboard (Next.js — port 3000)
# ───────────────────────────────────────────────────────────────
echo "  [2/2] Starting Dashboard (port 3000)..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "
        tell application "Terminal"
            do script "cd '$NEXUS_DIR/dashboard' && npm run dev"
        end tell
    "
else
    if command -v gnome-terminal &>/dev/null; then
        gnome-terminal --title="Nexus Dashboard (3000)" -- bash -c "cd '$NEXUS_DIR/dashboard' && npm run dev; exec bash"
    elif command -v xterm &>/dev/null; then
        xterm -title "Nexus Dashboard (3000)" -e "cd '$NEXUS_DIR/dashboard' && npm run dev" &
    else
        (cd "$NEXUS_DIR/dashboard" && npm run dev) &
    fi
fi

echo ""
echo "  ==============================================="
echo "    Nexus is starting up!"
echo "  ==============================================="
echo ""
echo "    URLs:"
echo "    - Dashboard:    http://localhost:3000"
echo "    - Node API:     http://localhost:4000"
echo ""
echo "    Close the terminal windows to stop services."
echo ""
