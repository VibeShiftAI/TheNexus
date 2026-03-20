#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  THE NEXUS — Local Development Startup (macOS)
#  Double-click this file to start all services
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

osascript -e "
    tell application \"Terminal\"
        activate
        do script \"cd '$NEXUS_DIR/nexus-builder' && source venv/bin/activate && PYTHONPATH='$NEXUS_DIR':\$PYTHONPATH uvicorn main:app --reload --port 8000\"
    end tell
"

sleep 1

# ───────────────────────────────────────────────────────────────
# 2. Start Node.js Backend (port 4000)
# ───────────────────────────────────────────────────────────────
echo "  [2/3] Starting Node.js Backend (port 4000)..."

osascript -e "
    tell application \"Terminal\"
        do script \"cd '$NEXUS_DIR' && node server/server.js\"
    end tell
"

sleep 2

# ───────────────────────────────────────────────────────────────
# 3. Start Dashboard (Next.js — port 3000)
# ───────────────────────────────────────────────────────────────
echo "  [3/3] Starting Dashboard (port 3000)..."

osascript -e "
    tell application \"Terminal\"
        do script \"cd '$NEXUS_DIR/dashboard' && npm run dev\"
    end tell
"

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
