#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  THE NEXUS — Local Development Startup (macOS / Linux)
#  Equivalent of start-local.bat for Windows
# ═══════════════════════════════════════════════════════════════

NEXUS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ==============================================="
echo "    THE NEXUS - Local Development Startup"
echo "  ==============================================="
echo ""

# ───────────────────────────────────────────────────────────────
# 1. Start LangGraph Engine (Python — port 8000)
# ───────────────────────────────────────────────────────────────
echo "  [1/3] Starting LangGraph Engine (port 8000)..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS — open a new Terminal.app window
    osascript -e "
        tell application \"Terminal\"
            activate
            do script \"cd '$NEXUS_DIR/nexus-builder' && source venv/bin/activate && PYTHONPATH='$NEXUS_DIR':\$PYTHONPATH uvicorn main:app --reload --port 8000\"
        end tell
    "
else
    # Linux — try common terminal emulators
    if command -v gnome-terminal &>/dev/null; then
        gnome-terminal --title="LangGraph Engine (8000)" -- bash -c "cd '$NEXUS_DIR/nexus-builder' && source venv/bin/activate && PYTHONPATH='$NEXUS_DIR':\$PYTHONPATH uvicorn main:app --reload --port 8000; exec bash"
    elif command -v xterm &>/dev/null; then
        xterm -title "LangGraph Engine (8000)" -e "cd '$NEXUS_DIR/nexus-builder' && source venv/bin/activate && PYTHONPATH='$NEXUS_DIR':\$PYTHONPATH uvicorn main:app --reload --port 8000" &
    else
        echo "    ⚠ No supported terminal emulator found. Starting in background..."
        (cd "$NEXUS_DIR/nexus-builder" && source venv/bin/activate && PYTHONPATH="$NEXUS_DIR":$PYTHONPATH uvicorn main:app --reload --port 8000) &
    fi
fi

sleep 1

# ───────────────────────────────────────────────────────────────
# 2. Start Node.js Backend (port 4000)
# ───────────────────────────────────────────────────────────────
echo "  [2/3] Starting Node.js Backend (port 4000)..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "
        tell application \"Terminal\"
            do script \"cd '$NEXUS_DIR' && node server/server.js\"
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
# 3. Start Dashboard (Next.js — port 3000)
# ───────────────────────────────────────────────────────────────
echo "  [3/3] Starting Dashboard (port 3000)..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "
        tell application \"Terminal\"
            do script \"cd '$NEXUS_DIR/dashboard' && npm run dev\"
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
echo "    - LangGraph:    http://localhost:8000"
echo ""
echo "    Close the terminal windows to stop services."
echo "    Or run: ./stop-nexus.sh"
echo ""
