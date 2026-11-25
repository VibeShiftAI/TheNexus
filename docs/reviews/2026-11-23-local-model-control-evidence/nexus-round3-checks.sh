#!/bin/bash
# Task fa032fc0, after the delta reviews of 13:07: the TheNexus reasoning-row
# assertion and the TheCortex read-order fix. Same guards as every earlier run.
# (1) TheNexus local-model-selection.test.js on the working tree.
# (2) TheNexus mutation X: the made row always claims reasoning, in a scratch
#     copy (git archive HEAD plus the working changes). The new assertion fails.
# (3) The 23 related TheNexus server suites on the working tree.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
N=$W/TheNexus
echo "== (1) TheNexus local-model-selection.test.js at $(git -C $N rev-parse --short HEAD) plus the working change"
rm -f $S/net-guard-sel-r3.log
(cd $N && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-sel-r3.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest server/__tests__/local-model-selection.test.js --cacheDirectory $S/jest-cache > $S/nexus-selection-r3.txt 2>&1; echo "exit $?" >> $S/nexus-selection-r3.txt)
grep -E "^Tests:|^exit" $S/nexus-selection-r3.txt
echo "network guard refusals: $(cat $S/net-guard-sel-r3.log 2>/dev/null | wc -l | tr -d ' ')"

echo "== (2) mutation X in a scratch copy"
M=$S/nexus-mutation-x
mkdir -p "$M" || exit 1
[ -z "$(ls -A "$M")" ] || { echo "nexus-mutation-x is not empty, stopping"; exit 1; }
git -C $N archive HEAD server db package.json | tar -x -C "$M" || { echo "archive failed"; exit 1; }
cp $N/server/__tests__/local-model-selection.test.js "$M/server/__tests__/local-model-selection.test.js"
ln -s $N/node_modules "$M/node_modules"
F="$M/server/services/local-model-selection.js"
/usr/bin/python3 - "$F" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
old = "capabilities: { chat: true, local: true, ...(reasoning ? { reasoning: true } : {}) },"
new = "capabilities: { chat: true, local: true, reasoning: true },"
assert src.count(old) == 1, "row capabilities line not found exactly once"
open(path, "w", encoding="utf-8").write(src.replace(old, new))
print("mutation X applied: every made row claims reasoning")
PY
diff -u $N/server/services/local-model-selection.js "$F"
rm -f $S/net-guard-mut-x.log
(cd "$M" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-mut-x.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest server/__tests__/local-model-selection.test.js --cacheDirectory $S/jest-cache-mut > $S/nexus-mutation-x.txt 2>&1; echo "exit $?" >> $S/nexus-mutation-x.txt)
grep -E "^Tests:|^exit" $S/nexus-mutation-x.txt
grep -E "✕" $S/nexus-mutation-x.txt
echo "network guard refusals: $(cat $S/net-guard-mut-x.log 2>/dev/null | wc -l | tr -d ' ')"

echo "== (3) the 23 related TheNexus server suites on the working tree"
rm -f $S/net-guard-related-r3.log
(cd $N && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-related-r3.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" npx jest \
  server/__tests__/local-model-selection.test.js server/__tests__/model-control-route.test.js server/__tests__/model-rows-migration.test.js \
  server/__tests__/model-control-db.test.js server/__tests__/model-control-resolver.test.js server/__tests__/studio-route.test.js \
  server/__tests__/studio-ingestion.test.js server/__tests__/astro-nightly.test.js server/__tests__/astro-nightly-backfill.test.js \
  server/__tests__/calendar-model-control.test.js server/__tests__/tasks-model-control.test.js server/__tests__/model-roles.test.js \
  server/__tests__/cortex-role-seeds.test.js server/__tests__/board-summary.test.js server/__tests__/local-operator-flows.test.js \
  server/__tests__/mail-draft-auth-mount.test.js server/__tests__/maintenance-auth-mount.test.js server/__tests__/operator-confirmation.test.js \
  server/__tests__/presentations.test.js server/__tests__/provenance-trust-boundaries.test.js server/__tests__/retired-orchestration.test.js \
  server/__tests__/task-dispatch-auth-mount.test.js server/__tests__/local-model-work.test.js \
  --cacheDirectory $S/jest-cache > $S/nexus-related-r3.txt 2>&1; echo "exit $?" >> $S/nexus-related-r3.txt)
grep -E "^Tests:|^Test Suites:|^exit" $S/nexus-related-r3.txt
echo "network guard refusals: $(cat $S/net-guard-related-r3.log 2>/dev/null | wc -l | tr -d ' ')"
echo "== done"
