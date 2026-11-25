#!/bin/bash
# Usage: bash cortex-tests.sh <cortex dir> <output file> [test files...]
DIR="$1"; OUT="$2"; shift 2
cd "$DIR" || exit 2
env NEO4J_URI=bolt://127.0.0.1:1 NEXUS_API_URL=http://127.0.0.1:1/api NEXUS_URL=http://127.0.0.1:1 \
  PRAXIS_API_URL=http://127.0.0.1:1 LM_STUDIO_BASE_URL=http://127.0.0.1:1/v1 \
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=python:tests \
  /Volumes/Projects/TheCortex/TheCortex/venv/bin/python -m pytest -p offline_network_guard -p no:cacheprovider \
  -m "not integration" -q "$@" > "$OUT" 2>&1
echo "exit=$?" >> "$OUT"
