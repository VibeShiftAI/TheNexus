#!/bin/bash
# Task fa032fc0: the Praxis branch work on a tree that merges it with Praxis main
# 4d076f91 (main moved after the round-2 merged check at 24c1abaa). Built from
# `git archive main` plus the branch diff against the task baseline, outside every
# repository (no worktree, branch or clone). Same guards as the branch runs.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
P=$W/Praxis
MP=$S/merged-praxis4
echo "== Praxis: main $(git -C $P rev-parse --short main), branch $(git -C $P rev-parse --short HEAD), base 1fcf4b59"
mkdir -p "$MP" || exit 1
[ -z "$(ls -A "$MP")" ] || { echo "merged-praxis4 is not empty, stopping"; exit 1; }
git -C $P archive main | tar -x -C "$MP" || { echo "archive failed"; exit 1; }
git -C $P diff --binary 1fcf4b59 HEAD > $S/praxis-branch4.patch
(cd "$MP" && git apply --whitespace=nowarn $S/praxis-branch4.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch4.patch) files"
ln -s $P/node_modules "$MP/node_modules"
(cd "$MP" && npx tsc --noEmit > $S/praxis-tsc-merged-main4.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main4.txt)
echo "tsc: $(tail -1 $S/praxis-tsc-merged-main4.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-main4.txt) errors)"
FILES=""; MISSING=""
for t in $(cat $S/praxis-tests.txt) local_model_primary llm_cli_lane_complete knowledge_arbitrary_limits standing_fact_sweep state_doc nexus_client_funnel; do
  if [ -f "$MP/tests/$t.test.ts" ]; then FILES="$FILES tests/$t.test.ts"; else MISSING="$MISSING $t"; fi
done
echo "related test files on the merged tree: $(echo $FILES | wc -w | tr -d ' '); not on main:${MISSING:- none}"
: > $S/lmstudio-guard-merged4.log; : > $S/lms-calls.log; rm -f $S/net-guard-praxis-merged4.log
(cd "$MP" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-merged4.log NET_GUARD_LOG=$S/net-guard-praxis-merged4.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" npm test -- $FILES > $S/praxis-merged-main4-tests.txt 2>&1; echo "exit $?" >> $S/praxis-merged-main4-tests.txt)
grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-merged-main4-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/praxis-merged-main4-tests.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | head -10
cp $S/lms-calls.log $S/lms-calls-merged4.log
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-merged4.log | tr -d ' ') fake-lms=$(wc -l < $S/lms-calls-merged4.log | tr -d ' ') net=$(cat $S/net-guard-praxis-merged4.log 2>/dev/null | wc -l | tr -d ' ')"
echo "== done"
