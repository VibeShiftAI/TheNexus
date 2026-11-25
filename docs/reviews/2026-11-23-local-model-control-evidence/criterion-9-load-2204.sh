#!/bin/bash
# Task fa032fc0, criterion 9: who asked for the Gemma load LM Studio logged at
# 22:04:03 EST on 2026-11-24, after the merge-conflict repair's 21:45:04
# read-back and before the 22:04:57 one. Reads two logs only; contacts no
# service. Times: praxis.log is UTC (Z), LM Studio's log is local (EST = UTC-5).
LMS_LOGS=(/Users/robertwashko/.lmstudio/server-logs/2026-11/2026-11-24.*.log)
PRAXIS_LOG=/Volumes/Projects/Praxis/data/logs/praxis.log
echo "# Made $(date '+%Y-%m-%d %H:%M:%S %Z') by a read-only script; no service contacted."
echo
echo "## LM Studio's server log: every model load and unload from 21:00 EST on"
cat "${LMS_LOGS[@]}" | grep -E 'Endpoint=(loadModel|unloadModel)|Unloading model' | awk -F'[][]' '$2 >= "2026-11-24 21:00:00"'
echo
echo "## The live Praxis log from 03:00:00Z to 03:04:45Z (22:00:00 to 22:04:45 EST):"
echo "## the nightly scheduler, the intake sweep, the local calls, the autoload and"
echo "## the gateway calls that followed (executor report echoes, 'Full body', left out)"
grep -E '^\[2026-11-25T03:0[0-4]' "$PRAXIS_LOG" | grep -v 'Full body' \
  | grep -E 'Nightly ingestion|local LLM job|Knowledge intake sweep|EvidencePreparation|Pinned call|LmAutoload|LocalLane|gateway ok route=role:cortex' \
  | awk '$1 <= "[2026-11-25T03:04:45"' | cut -c1-260
echo
echo "## The local-lane window"
echo "22:04 ET is inside the 22:00-06:00 ET local-lane window, the window the read-back's LocalLane lines name."
