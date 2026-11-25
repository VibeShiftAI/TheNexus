#!/bin/bash
# Task fa032fc0, round 2: every repository's branch work on a tree that merges it
# with current main, built from `git archive main` plus the branch diff against
# the task baseline, outside every repository (no worktree, branch or clone).
# Same guards as the branch runs: LM Studio and network guards for Praxis, the
# network guard for TheNexus, the offline plugin and port-1 endpoints for TheCortex.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
N=$W/TheNexus
P=$W/Praxis
C=$W/TheCortex

fresh() { # remove a scratch tree, its node_modules links first (as links), then recreate it
  local d="$1"
  for l in "$d/node_modules" "$d/dashboard/node_modules"; do [ -L "$l" ] && rm -f "$l"; done
  rm -rf "$d" && mkdir -p "$d"
}

echo "== TheNexus: main $(git -C $N rev-parse --short main), branch $(git -C $N rev-parse --short HEAD), base bd02642"
M=$S/merged-main
fresh "$M"
git -C $N archive main | tar -x -C "$M" || { echo "archive failed"; exit 1; }
git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e HEAD > $S/branch-vs-baseline.patch
(cd "$M" && git apply --whitespace=nowarn $S/branch-vs-baseline.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/branch-vs-baseline.patch) files"
ln -s $N/node_modules "$M/node_modules"
(cd "$M" && node --check server/server.js && echo "merged server/server.js parses")
NEXUS_SUITES=""
for t in astro-nightly-backfill astro-nightly board-summary calendar-model-control cortex-role-seeds local-model-selection \
  local-model-work local-operator-flows mail-draft-auth-mount maintenance-auth-mount model-control-db model-control-resolver \
  model-control-route model-roles model-rows-migration operator-confirmation presentations provenance-trust-boundaries \
  retired-orchestration studio-ingestion studio-route task-dispatch-auth-mount tasks-model-control; do
  NEXUS_SUITES="$NEXUS_SUITES server/__tests__/$t.test.js"
done
echo "server suites named: $(echo $NEXUS_SUITES | wc -w | tr -d ' ')"
rm -f $S/net-guard-merged3.log
(cd "$M" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-merged3.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest $NEXUS_SUITES --cacheDirectory $S/jest-cache-merged > $S/nexus-merged-main3-tests.txt 2>&1; echo "exit $?" >> $S/nexus-merged-main3-tests.txt)
grep -E "^Tests:|^Test Suites:|^exit" $S/nexus-merged-main3-tests.txt
grep -E "^FAIL " $S/nexus-merged-main3-tests.txt
echo "network guard refusals: $(cat $S/net-guard-merged3.log 2>/dev/null | wc -l | tr -d ' ')"
ln -s $N/dashboard/node_modules "$M/dashboard/node_modules"
(cd "$M/dashboard" && node $N/dashboard/node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json > $S/dashboard-tsc-merged-main3.txt 2>&1; echo "exit $?" >> $S/dashboard-tsc-merged-main3.txt)
echo "dashboard tsc: $(tail -1 $S/dashboard-tsc-merged-main3.txt) ($(grep -c 'error TS' $S/dashboard-tsc-merged-main3.txt) errors)"
DASH_TESTS="src/components/__tests__/local-model-chooser.test.mjs src/components/__tests__/chat-model-control.test.mjs src/lib/__tests__/fast-refresh-boundaries.test.ts"
for f in $DASH_TESTS; do [ -f "$M/dashboard/$f" ] || echo "MISSING on merged tree: $f"; done
(cd "$M/dashboard" && node --import ./test/register.mjs --test $DASH_TESTS > $S/dashboard-merged-main3-tests.txt 2>&1; echo "exit $?" >> $S/dashboard-merged-main3-tests.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/dashboard-merged-main3-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/dashboard-merged-main3-tests.txt | grep -v "failing tests" | head -10

echo "== Praxis: main $(git -C $P rev-parse --short main), branch $(git -C $P rev-parse --short HEAD), base 1fcf4b59"
MP=$S/merged-praxis
fresh "$MP"
git -C $P archive main | tar -x -C "$MP" || { echo "archive failed"; exit 1; }
git -C $P diff --binary 1fcf4b59 HEAD > $S/praxis-branch.patch
(cd "$MP" && git apply --whitespace=nowarn $S/praxis-branch.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch.patch) files"
ln -s $P/node_modules "$MP/node_modules"
(cd "$MP" && npx tsc --noEmit > $S/praxis-tsc-merged-main3.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main3.txt)
echo "tsc: $(tail -1 $S/praxis-tsc-merged-main3.txt)"
FILES=""; MISSING=""
for t in $(cat $S/praxis-tests.txt) local_model_primary llm_cli_lane_complete knowledge_arbitrary_limits standing_fact_sweep state_doc; do
  if [ -f "$MP/tests/$t.test.ts" ]; then FILES="$FILES tests/$t.test.ts"; else MISSING="$MISSING $t"; fi
done
echo "related test files on the merged tree: $(echo $FILES | wc -w | tr -d ' '); not on main:${MISSING:- none}"
: > $S/lmstudio-guard-merged3.log; : > $S/lms-calls.log; rm -f $S/net-guard-praxis-merged3.log
(cd "$MP" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-merged3.log NET_GUARD_LOG=$S/net-guard-praxis-merged3.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" npm test -- $FILES > $S/praxis-merged-main3-tests.txt 2>&1; echo "exit $?" >> $S/praxis-merged-main3-tests.txt)
grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-merged-main3-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/praxis-merged-main3-tests.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | head -10
cp $S/lms-calls.log $S/lms-calls-merged3.log
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-merged3.log | tr -d ' ') fake-lms=$(wc -l < $S/lms-calls-merged3.log | tr -d ' ') net=$(cat $S/net-guard-praxis-merged3.log 2>/dev/null | wc -l | tr -d ' ')"

echo "== TheCortex: main $(git -C $C rev-parse --short main), branch $(git -C $C rev-parse --short HEAD), base 5fdb76a"
MC=$S/merged-cortex
fresh "$MC"
git -C $C archive main | tar -x -C "$MC" || { echo "archive failed"; exit 1; }
git -C $C diff --binary 5fdb76a HEAD > $S/cortex-branch.patch
(cd "$MC" && git apply --whitespace=nowarn $S/cortex-branch.patch) || { echo "CORTEX APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/cortex-branch.patch) files"
ln -s $C/TheCortex/.env "$MC/TheCortex/.env"
grep -n "cortex_test_guard.install\|def local_model_setting_offline" "$MC/TheCortex/conftest.py"
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merged-main3-tests.txt tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py \
  tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py tests/test_praxis_local_llm_route.py tests/test_client_embedder.py \
  python/test_acted_on_retrieval.py python/test_packet_format.py python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py
grep -E "cortex_test_guard|passed|failed|error|exit=" $S/cortex-merged-main3-tests.txt | tail -6
echo "== done"
