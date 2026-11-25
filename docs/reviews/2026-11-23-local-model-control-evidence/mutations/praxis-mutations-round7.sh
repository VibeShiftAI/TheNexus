#!/bin/bash
# Round 7 mutations: each takes one part of the round-7 fixes (the three items the
# review of round 6 found) out of a scratch copy of Praxis 196a5375 and runs the
# suite the round-7 tests are in, with the two other suites that drive the slot
# claim, under the same guards as every Praxis run here (LM Studio guard, network
# guard, live-port guard, fake lms, CLI shims). The diff each mutation made is
# printed before its result, so what was removed can be read here.
#   k1: the slot claim matches a replaced model by its spelling, as bd19e926 did
#       (nit 3; the respelling test should fail)
#   k2: primaryForTest restores the manager's provider and cache epoch but not its
#       model (finding 1; the primary-restore test should fail)
#   k3: primaryForTest restores the provider and the model but not the cache epoch
#       (nit 2; the primary-restore test should fail)
# The primary-restore test clears the explicit primary itself, so it should hold
# whatever the environment sets: this shell exports LLM_PRIMARY_PROVIDER and
# LLM_PRIMARY_MODEL (test runs do not load Praxis's .env), and the control runs
# once more with those two variables unset.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
HEAD_UNDER_TEST=196a537506d8b9076753ee1143cd527c3ac6eb14
SUITES="tests/local_model_selection.test.ts tests/lmstudio_autoload.test.ts tests/local_model_demand_callers.test.ts"
D=$S/praxis-mut-r7
rm -rf "$D" && mkdir -p "$D"
git -C $P archive $HEAD_UNDER_TEST | tar -x -C "$D"
ln -s $P/node_modules "$D/node_modules"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Praxis under test: $HEAD_UNDER_TEST (scratch copy $D)"
echo "suites: $SUITES"

apply() { # file perl-expression
  local F="$D/$1"
  [ -f "$F.orig" ] || cp "$F" "$F.orig"
  local before
  before=$(cat "$F")
  perl -0pi -e "$2" "$F"
  # Each expression must change the file; one that matched nothing leaves the
  # copy as it was, and the mutation is skipped rather than run unchanged.
  if [ "$before" = "$(cat "$F")" ]; then echo "   NOT APPLIED to $1"; restore; return 1; fi
  diff -u "$F.orig" "$F" | tail -n +3 | sed "s|^|   $1 |"
}
restore() {
  find "$D/src" "$D/tests" -name '*.orig' | while read -r f; do mv "$f" "${f%.orig}"; done
}
run() { # name [env -u flags]
  local name=$1; shift
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-mut.txt
  : > $S/lmstudio-guard-mut.log; : > $S/live-port-guard-mut.log; : > $S/cli-shims.log; rm -f $S/net-guard-mut.log
  (cd "$D" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY "$@" LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
    PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
    PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
    LIVE_PORTS_FILE=$S/live-ports-mut.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-mut.log \
    NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
    npm test -- $SUITES > $S/praxis-mutation-r7-$name.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-r7-$name.txt)
  echo "   result: $(grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-mutation-r7-$name.txt | tr '\n' ' ')"
  grep -E "^✖ " $S/praxis-mutation-r7-$name.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | sed 's/^/   /'
  # The assertion message each failing test stopped at.
  grep -E "^ *(AssertionError|  message:)" $S/praxis-mutation-r7-$name.txt | sort -u | head -6 | sed 's/^ */   assertion: /'
  echo "   guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log | tr -d ' ') net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-mut.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims.log | tr -d ' ')"
  restore
}

echo "== control: no mutation"
run control

echo "== k1: the slot claim matches a replaced model by its spelling (the bd19e926 lookup)"
apply src/llm/lmstudio-autoload.ts 's/\n    const key = localModelKey\(requestedModel\);\n    const replaced = switchedAwayLocalModels\(\)\.find\(\(s\) => localModelKey\(s\.model\) === key && /\n    const replaced = switchedAwayLocalModels().find((s) => s.model === requestedModel && /' && run k1

echo "== k2: primaryForTest restores the provider and the cache epoch, not the model"
apply tests/local_model_selection.test.ts 's/\n    manager\.activeModel = before\.model;\n    manager\.cacheEpoch = before\.cacheEpoch;\n/\n    manager.cacheEpoch = before.cacheEpoch;\n/' && run k2

echo "== k3: primaryForTest restores the provider and the model, not the cache epoch"
apply tests/local_model_selection.test.ts 's/\n    manager\.activeModel = before\.model;\n    manager\.cacheEpoch = before\.cacheEpoch;\n/\n    manager.activeModel = before.model;\n/' && run k3

echo "== control-no-primary: no mutation, LLM_PRIMARY_PROVIDER and LLM_PRIMARY_MODEL unset"
run control-no-primary -u LLM_PRIMARY_PROVIDER -u LLM_PRIMARY_MODEL

restore
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== scratch copy left at $D for inspection; deleted with the scratch folder"
