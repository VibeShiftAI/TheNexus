#!/bin/bash
# Runs the named Praxis suites in DIR under every guard used for round 4: the LM
# Studio guard, the network guard, the live-port guard (ports listening before the
# run and hosts off this machine), the fake lms and the CLI shims. Usage:
#   praxis-files-guarded.sh DIR TAG name [name ...]
S=/Volumes/Projects/.scratch-fa032fc0
DIR=$1; TAG=$2; shift 2
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-$TAG.txt
FILES=$(for n in "$@"; do printf 'tests/%s.test.ts ' "$n"; done)
: > $S/lmstudio-guard-$TAG.log; : > $S/lms-calls-$TAG.log; : > $S/live-port-guard-$TAG.log; : > $S/cli-shims.log; rm -f $S/net-guard-$TAG.log
(cd $DIR && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-$TAG.log NET_GUARD_LOG=$S/net-guard-$TAG.log \
  LIVE_PORTS_FILE=$S/live-ports-$TAG.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-$TAG.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
  npm test -- $FILES > $S/praxis-$TAG-run.txt 2>&1; echo "exit $?" >> $S/praxis-$TAG-run.txt)
cp $S/cli-shims.log $S/cli-shims-$TAG.log
echo "== $TAG in $DIR: $*"
grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-$TAG-run.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/praxis-$TAG-run.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | head -30
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-$TAG.log | tr -d ' ') net=$(cat $S/net-guard-$TAG.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-$TAG.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims-$TAG.log | tr -d ' ')"
