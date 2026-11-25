#!/bin/bash
# Finding 5 (primaryForTest restored the manager's provider and not its model),
# shown where it can be seen. In praxis-mutations-round6.sh, s8 passes with and
# without LLM_PRIMARY_PROVIDER and LLM_PRIMARY_MODEL: a test run reads no model
# registry, so chat()'s Antigravity rung resolves to "antigravity-default"
# (llm/antigravity-provider.ts antigravityGeminiModel), the model the manager
# starts with when no primary is set (llm/manager.ts constructor), and the model
# the round-5 helper left behind equals the one it replaced.
#
# Here the test data folder holds a model registry that lists one Gemini model
# for the Antigravity lane (the fixture below), so chat()'s fallback names that
# model, and the two primary variables are unset so the fallback makes it the
# primary. Each run is bounded by an alarm (270 s) because a run that loses the
# manager's model can wait on a call that never comes; processes left by an
# alarm are listed and stopped by PID.
#   control-registry:      Praxis bd19e926 as committed, whole suite
#   pair-control-registry: as committed, only the two tests the leak passes between
#   pair-s8-registry:      the round-5 helper (provider only), the same two tests
#   s8-registry:           the round-5 helper, whole suite
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
HEAD_UNDER_TEST=bd19e926a16509bd213f49c20f4c95bed95a43e9
D=$S/praxis-mut-r6-registry
rm -rf "$D" && mkdir -p "$D"
git -C $P archive $HEAD_UNDER_TEST | tar -x -C "$D"
ln -s $P/node_modules "$D/node_modules"
echo "Praxis under test: $HEAD_UNDER_TEST (scratch copy $D)"
REGISTRY='{"schemaVersion":1,"generatedAt":"2026-11-24T00:00:00Z","executors":{"antigravity":{"executor":"antigravity","source":"test","models":[{"id":"gemini-3.1-pro-preview","label":"Gemini 3.1 Pro (fixture)","listed":true}]}}}'
echo "registry fixture: $REGISTRY"
PAIR='--test-name-pattern=^(chat\(\) on a local primary that read Gemma before a switch took effect during its admission|complete\(\) for a role resolved through local_default that read Gemma before a switch took effect during its admission)'

run() { # name [extra runner flag]
  local name=$1 flag=$2 data=$S/registry-data-$1
  rm -rf "$data" && mkdir -p "$data" && printf '%s\n' "$REGISTRY" > "$data/model-registry.json"
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-mut.txt
  : > $S/lmstudio-guard-mut.log; : > $S/live-port-guard-mut.log; : > $S/cli-shims.log; rm -f $S/net-guard-mut.log
  (cd "$D" && perl -e 'alarm 270; exec @ARGV' env -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY -u LLM_PRIMARY_PROVIDER -u LLM_PRIMARY_MODEL \
    PRAXIS_DATA_DIR="$data" LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
    PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
    PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
    LIVE_PORTS_FILE=$S/live-ports-mut.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-mut.log \
    NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
    npm test -- ${flag:+"$flag"} tests/local_model_selection.test.ts > $S/praxis-mutation-r6-$name.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-r6-$name.txt)
  echo "   result: $(grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-mutation-r6-$name.txt | tr '\n' ' ')"
  echo "   passed: $(grep -c '^✔' $S/praxis-mutation-r6-$name.txt)"
  grep -E "^✖ " $S/praxis-mutation-r6-$name.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | sed 's/^/   /'
  # The first assertion detail of a failing test, when the run got as far as printing it.
  grep -m1 -A12 -E "^  (AssertionError|Error)|ERR_ASSERTION" $S/praxis-mutation-r6-$name.txt | grep -E "message|actual|expected|\+|-|Error" | head -12 | sed 's/^/   detail: /'
  grep -E "the manager's primary is as it was before the suite" $S/praxis-mutation-r6-$name.txt | head -2 | sed 's/^ */   hook: /'
  echo "   guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log | tr -d ' ') net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-mut.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims.log | tr -d ' ')"
  # Only processes working in this scratch copy: other runs in these
  # repositories may be running the same suite.
  local pid left=""
  for pid in $(ps -axo pid=,command= | grep -E "node|npm|tsx" | grep -v grep | awk '{print $1}'); do
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q "^n$D" && left="$left $pid"
  done
  if [ -n "$left" ]; then echo "   left running after the alarm, stopped:$left"; kill $left 2>/dev/null; fi
}
helper_provider_only() {
  perl -0pi -e 's/\n    manager\.activeModel = before\.model;\n/\n/' "$D/tests/local_model_selection.test.ts"
  if grep -q 'manager.activeModel = before.model;' "$D/tests/local_model_selection.test.ts"; then echo "   NOT APPLIED"; return 1; fi
  echo "   tests/local_model_selection.test.ts: removed the line restoring manager.activeModel in primaryForTest"
}

echo "== control-registry: as committed, whole suite"
run control-registry
echo "== pair-control-registry: as committed, the two tests only"
run pair-control-registry "$PAIR"
echo "== pair-s8-registry: the round-5 helper, the two tests only"
helper_provider_only && run pair-s8-registry "$PAIR"
echo "== s8-registry: the round-5 helper, whole suite"
run s8-registry
echo "== scratch copy left at $D for inspection; deleted with the scratch folder"
