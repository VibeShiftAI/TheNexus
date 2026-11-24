#!/bin/bash
# Task fa032fc0: the two Praxis tests that failed on the merged tree read git
# (`git rev-parse HEAD`, `git show 1cac649:src/webhook.ts`) and the merged tree is
# a plain directory. Show they fail the same way on plain main archived the same
# way (no branch diff), and list what the branch diff touches near them.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
PM=$S/plain-praxis-main
[ -L "$PM/node_modules" ] && rm -f "$PM/node_modules"
rm -rf "$PM" && mkdir -p "$PM"
git -C $P archive main | tar -x -C "$PM" || { echo "archive failed"; exit 1; }
ln -s $P/node_modules "$PM/node_modules"
echo "== plain main $(git -C $P rev-parse --short main), archived, no branch diff"
: > $S/lmstudio-guard-plain.log; : > $S/lms-calls.log; rm -f $S/net-guard-plain.log
(cd "$PM" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-plain.log NET_GUARD_LOG=$S/net-guard-plain.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
  npm test -- tests/code_freshness_recovery.test.ts tests/webhook_routes_inventory.test.ts > $S/praxis-plain-main-git-tests.txt 2>&1; echo "exit $?" >> $S/praxis-plain-main-git-tests.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/praxis-plain-main-git-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/praxis-plain-main-git-tests.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u
grep -c "not a git repository" $S/praxis-plain-main-git-tests.txt | sed 's/^/"not a git repository" lines: /'
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-plain.log | tr -d ' ') net=$(cat $S/net-guard-plain.log 2>/dev/null | wc -l | tr -d ' ')"
echo "== the same two files on the branch worktree (a git checkout)"
: > $S/lmstudio-guard-branchgit.log; rm -f $S/net-guard-branchgit.log
(cd "$P" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-branchgit.log NET_GUARD_LOG=$S/net-guard-branchgit.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
  npm test -- tests/code_freshness_recovery.test.ts tests/webhook_routes_inventory.test.ts > $S/praxis-branch-git-tests.txt 2>&1; echo "exit $?" >> $S/praxis-branch-git-tests.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/praxis-branch-git-tests.txt | tr '\n' ' '; echo
echo "== files the Praxis branch diff (1fcf4b59..HEAD) changes"
git -C $P diff --name-only 1fcf4b59 HEAD
echo "== route registrations or freshness code in that diff"
git -C $P diff 1fcf4b59 HEAD | grep -E '^\+' | grep -nE 'router\.(get|post|put|delete|patch)\(|app\.(get|post|put|delete|patch)\(|freshness' | head
echo "(end)"
[ -L "$PM/node_modules" ] && rm -f "$PM/node_modules"
rm -rf "$PM"
