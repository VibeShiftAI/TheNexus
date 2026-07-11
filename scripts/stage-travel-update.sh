#!/usr/bin/env bash
#
# stage-travel-update.sh — publish a new travel-shell version to the tunnel.
#
# Downloads the signed update payload (nexus-travel-setup.exe + .sig +
# latest.json) from a CI run of "Desktop (Windows ARM64)" and drops it into
# desktop/updates/, which the node server serves at
# https://nexus.vibeshiftai.com/api/updates/. The next time the travel app
# launches it sees the new latest.json and offers the update.
#
# Usage:
#   scripts/stage-travel-update.sh            # latest successful run on main
#   scripts/stage-travel-update.sh <run-id>   # a specific run
#
# Requires: gh (authenticated as VibeShiftAI), run from the repo.
set -euo pipefail

REPO="VibeShiftAI/TheNexus"
WORKFLOW="Desktop (Windows ARM64)"
ARTIFACT="the-nexus-windows-arm64"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HERE/desktop/updates"

run_id="${1:-}"
if [[ -z "$run_id" ]]; then
  echo "Finding the latest successful build on main…"
  run_id="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" \
    --branch main --status success --limit 1 --json databaseId \
    --jq '.[0].databaseId')"
  [[ -n "$run_id" ]] || { echo "No successful run found." >&2; exit 1; }
fi
echo "Using run $run_id"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh run download "$run_id" --repo "$REPO" --name "$ARTIFACT" --dir "$tmp"

# The signed run ships latest.json; a legacy unsigned run ships only the .exe.
if [[ ! -f "$tmp/latest.json" ]]; then
  echo "This run has no latest.json — it was built unsigned (no signing" >&2
  echo "secret at build time). Set TAURI_SIGNING_PRIVATE_KEY and rebuild." >&2
  exit 1
fi

mkdir -p "$DEST"
cp -f "$tmp/nexus-travel-setup.exe" "$tmp/nexus-travel-setup.exe.sig" "$tmp/latest.json" "$DEST/"

version="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DEST/latest.json")"
echo "Staged v$version → $DEST"
echo "Live at https://nexus.vibeshiftai.com/api/updates/latest.json (behind Access)."
