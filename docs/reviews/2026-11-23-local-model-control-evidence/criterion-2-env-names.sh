#!/bin/bash
# Task fa032fc0, criterion 2: which of the environment names that name or pick a
# local model are set on this machine, in the env files the three services read
# and in the launch agents that start them. It prints counts only, never a
# value; for three names it prints a yes/no about the value instead (whether
# LLM_PRIMARY_PROVIDER is "local", whether LOCAL_LLM_MODEL names Gemma, and
# which transport PRAXIS_EVAL_FALLBACK_MODEL's route names: local or a
# subscription CLI, as parsed by Praxis's src/evals/inference-policy.ts).
# Read-only.
FILES=(
  /Volumes/Projects/Praxis/.env
  /Volumes/Projects/.fleet-env
  /Volumes/Projects/TheNexus/.env
  /Volumes/Projects/TheCortex/TheCortex/.env
  "$HOME/Library/LaunchAgents/com.praxis.bot.plist"
  "$HOME/Library/LaunchAgents/com.praxis.homehub-updates.plist"
  "$HOME/Library/LaunchAgents/com.praxis.voice.plist"
  "$HOME/Library/LaunchAgents/com.praxis.watchdog.plist"
  "$HOME/Library/LaunchAgents/com.thenexus.vault-watcher.plist"
  "$HOME/Library/LaunchAgents/The Nexus.plist"
)
NAMES="LOCAL_LLM_MODEL LLM_PRIMARY_MODEL LLM_PRIMARY_PROVIDER LOCAL_STUDIO_MODEL LM_STUDIO_MODEL LMSTUDIO_MODEL
PRAXIS_EVAL_LOCAL_MODEL PRAXIS_EVAL_FALLBACK_MODEL PRAXIS_EVAL_JUDGE_MODEL PRAXIS_EVAL_TEACHER_MODEL
PRAXIS_CREDIT_FALLBACK_MODEL TRADING_LOCAL_MODEL REFLECTION_MODEL HOME_HUB_EDGE_LLM_URL EDGE_LLM_URL
HOME_HUB_EDGE_LLM_MODEL EDGE_LLM_MODEL CORTEX_TEACHER_MODEL CORTEX_GRAPHITI_MODEL"
count() { # file name
  case "$1" in
    *.plist) grep -c "<key>$2</key>" "$1" ;;
    *) grep -cE "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" ;;
  esac
}
echo "# Criterion 2 environment names, $(date '+%Y-%m-%d %H:%M:%S %Z'), counts only"
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "== $f: absent"; continue; fi
  set=""
  for n in $NAMES; do
    c=$(count "$f" "$n")
    [ "$c" != "0" ] && set="$set $n=$c"
  done
  echo "== $f: ${set:- none of the names set}"
done
for f in /Volumes/Projects/Praxis/.env /Volumes/Projects/.fleet-env /Volumes/Projects/TheNexus/.env /Volumes/Projects/TheCortex/TheCortex/.env; do
  v=$(grep -E '^[[:space:]]*(export[[:space:]]+)?LLM_PRIMARY_PROVIDER=' "$f" | tail -1 | cut -d= -f2- | tr -d "\"' ")
  [ -n "$v" ] && echo "$f: LLM_PRIMARY_PROVIDER is local: $([ "$v" = local ] && echo yes || echo no)"
  v=$(grep -E '^[[:space:]]*(export[[:space:]]+)?LOCAL_LLM_MODEL=' "$f" | tail -1 | cut -d= -f2-)
  [ -n "$v" ] && echo "$f: LOCAL_LLM_MODEL names Gemma: $(echo "$v" | grep -qi gemma && echo yes || echo no)"
  v=$(grep -E '^[[:space:]]*(export[[:space:]]+)?PRAXIS_EVAL_FALLBACK_MODEL=' "$f" | tail -1 | cut -d= -f2- | tr -d "\"' ")
  if [ -n "$v" ]; then
    is_local=no; is_cli=no; gemma=no
    [[ "$v" == local/* ]] && is_local=yes
    [[ "$v" == cli/* || "$v" == cli:* ]] && is_cli=yes
    echo "$v" | grep -qi gemma && gemma=yes
    echo "$f: PRAXIS_EVAL_FALLBACK_MODEL route starts local/: $is_local; starts cli/ or cli:: $is_cli; names Gemma: $gemma"
  fi
done
echo "# done"
