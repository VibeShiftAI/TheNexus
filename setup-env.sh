#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  THE NEXUS — Environment Configuration
#  Sets API keys in both .env and nexus-builder/.env
# ═══════════════════════════════════════════════════════════════

NEXUS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_ENV="$NEXUS_DIR/.env"
PYTHON_ENV="$NEXUS_DIR/nexus-builder/.env"

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║        THE NEXUS — Environment Setup                  ║"
echo "  ╠═══════════════════════════════════════════════════════╣"
echo "  ║  This will configure your API keys.                   ║"
echo "  ║  Press ENTER to keep the current value (shown in      ║"
echo "  ║  brackets). API keys are written to both .env files.  ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""

# Ensure .env files exist
if [ ! -f "$ROOT_ENV" ]; then
    if [ -f "$NEXUS_DIR/.env.example" ]; then
        cp "$NEXUS_DIR/.env.example" "$ROOT_ENV"
        echo "  Created .env from .env.example"
    else
        echo "  ERROR: .env.example not found. Run the installer first."
        exit 1
    fi
fi

if [ ! -f "$PYTHON_ENV" ]; then
    if [ -f "$NEXUS_DIR/nexus-builder/.env.example" ]; then
        cp "$NEXUS_DIR/nexus-builder/.env.example" "$PYTHON_ENV"
        echo "  Created nexus-builder/.env from .env.example"
    fi
fi

# ── Helper: read a key from an env file ───────────────────────
read_env_val() {
    local file="$1" key="$2"
    grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2-
}

# ── Read current values ──────────────────────────────────────
CUR_PROJECT_ROOT=$(read_env_val "$ROOT_ENV" "PROJECT_ROOT")
CUR_GOOGLE=$(read_env_val "$ROOT_ENV" "GOOGLE_API_KEY")
CUR_OPENAI=$(read_env_val "$ROOT_ENV" "OPENAI_API_KEY")
CUR_ANTHROPIC=$(read_env_val "$ROOT_ENV" "ANTHROPIC_API_KEY")
CUR_XAI=$(read_env_val "$ROOT_ENV" "XAI_API_KEY")

# ── Prompt helper ─────────────────────────────────────────────
prompt_val() {
    local label="$1" current="$2" result
    if [ -n "$current" ]; then
        read -r -p "  $label [$current]: " result
        echo "${result:-$current}"
    else
        read -r -p "  $label: " result
        echo "$result"
    fi
}

# ── Prompt for values ────────────────────────────────────────
echo "  ── Project Root ──────────────────────────────────────"
echo "  The folder containing your coding projects."
NEW_PROJECT_ROOT=$(prompt_val "PROJECT_ROOT" "$CUR_PROJECT_ROOT")
echo ""

echo "  ── API Keys (at least one required) ──────────────────"
echo ""
NEW_GOOGLE=$(prompt_val "GOOGLE_API_KEY" "$CUR_GOOGLE")
NEW_ANTHROPIC=$(prompt_val "ANTHROPIC_API_KEY" "$CUR_ANTHROPIC")
NEW_OPENAI=$(prompt_val "OPENAI_API_KEY" "$CUR_OPENAI")
NEW_XAI=$(prompt_val "XAI_API_KEY" "$CUR_XAI")
echo ""

# ── Write root .env ──────────────────────────────────────────
echo "  Writing .env ..."

cat > "$ROOT_ENV" << EOF
# ==============================================================================
# TheNexus Environment Variables
# ==============================================================================

# --- Server ---
PORT=4000
PROJECT_ROOT=${NEW_PROJECT_ROOT}

# --- AI Provider API Keys ---
GOOGLE_API_KEY=${NEW_GOOGLE}
OPENAI_API_KEY=${NEW_OPENAI}
ANTHROPIC_API_KEY=${NEW_ANTHROPIC}
XAI_API_KEY=${NEW_XAI}

# --- Frontend URLs ---
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_CORTEX_URL=http://localhost:8000
EOF

echo "    ✓ .env updated"

# ── Write nexus-builder .env ─────────────────────────────────
echo "  Writing nexus-builder/.env ..."

cat > "$PYTHON_ENV" << EOF
# ==============================================================================
# LangGraph Engine Environment Variables
# ==============================================================================

# AI Provider API Keys
GOOGLE_API_KEY=${NEW_GOOGLE}
ANTHROPIC_API_KEY=${NEW_ANTHROPIC}
OPENAI_API_KEY=${NEW_OPENAI}

# Node.js backend URL (for proxying requests)
NODEJS_BACKEND_URL=http://localhost:4000
EOF

echo "    ✓ nexus-builder/.env updated"

echo ""
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║         Configuration saved!                          ║"
echo "  ║                                                       ║"
echo "  ║   Run ./start-local.sh to start The Nexus.            ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo ""
