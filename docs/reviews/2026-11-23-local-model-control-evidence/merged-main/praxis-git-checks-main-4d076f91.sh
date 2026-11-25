#!/bin/bash
# Task fa032fc0: the two tests that failed on the tree merged with Praxis main
# 4d076f91 read git. (1) The route inventory test on that merged tree with the
# read-only git shim (forwards only `git show 1cac649:src/webhook.ts`).
# (2) Both files on plain main 4d076f91 archived the same way, no branch diff.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
MP=$S/merged-praxis4
PM=$S/plain-praxis-main4
echo "== (1) route inventory on the merged tree (main $(git -C $P rev-parse --short main) + branch diff), git shim"
: > $S/git-shim.log; : > $S/lmstudio-guard-inv4.log; rm -f $S/net-guard-inv4.log
(cd "$MP" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY PATH="$S/git-shim:$PATH" LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-inv4.log NET_GUARD_LOG=$S/net-guard-inv4.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
  npm test -- tests/webhook_routes_inventory.test.ts > $S/praxis-inventory-merged4.txt 2>&1; echo "exit $?" >> $S/praxis-inventory-merged4.txt)
grep -E "^✔|^✖|^ℹ (tests|pass|fail)|^exit" $S/praxis-inventory-merged4.txt | sed 's/ ([0-9.]*ms)$//'
echo "git shim log:"; cat $S/git-shim.log
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-inv4.log | tr -d ' ') net=$(cat $S/net-guard-inv4.log 2>/dev/null | wc -l | tr -d ' ')"
echo "== (2) plain main $(git -C $P rev-parse --short main), archived, no branch diff"
mkdir -p "$PM" || exit 1
[ -z "$(ls -A "$PM")" ] || { echo "plain-praxis-main4 is not empty, stopping"; exit 1; }
git -C $P archive main | tar -x -C "$PM" || { echo "archive failed"; exit 1; }
ln -s $P/node_modules "$PM/node_modules"
: > $S/lmstudio-guard-plain4.log; : > $S/lms-calls.log; rm -f $S/net-guard-plain4.log
(cd "$PM" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-plain4.log NET_GUARD_LOG=$S/net-guard-plain4.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
  npm test -- tests/code_freshness_recovery.test.ts tests/webhook_routes_inventory.test.ts > $S/praxis-plain-main4-git-tests.txt 2>&1; echo "exit $?" >> $S/praxis-plain-main4-git-tests.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/praxis-plain-main4-git-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/praxis-plain-main4-git-tests.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u
grep -c "not a git repository" $S/praxis-plain-main4-git-tests.txt | sed 's/^/"not a git repository" lines: /'
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-plain4.log | tr -d ' ') net=$(cat $S/net-guard-plain4.log 2>/dev/null | wc -l | tr -d ' ')"
echo "== done"
