#!/bin/bash
# Task fa032fc0: TheNexus main moved to 2a7952fc (15:51:16) after the merged
# check on a2870083. Its six changed files since then (moving a document's
# registration to its landed file when the run that wrote it lands:
# db/document-relocations.js, db/document-reviews.js, server/routes/documents.js,
# server/services/document-relocation.js, their test and a contract doc) share
# none with the branch. This repeats the merged check on 2a7952fc, pinned by its
# full hash, outside every repository (no worktree, branch or clone):
#  1. git merge-tree on the pinned main and the branch's last code commit
#     6e14bc87 (the commits after it change only this evidence folder, which
#     step 1 shows);
#  2. merged-nexus7 = git archive of the pinned main plus the branch diff
#     against bd02642, checked file by file against the merge-tree's tree;
#  3. the 27 server suites of the a2870083 check plus the server suite main
#     changed since a2870083 (document-relocations), keyless, under the network
#     guard, the LM Studio guard and the live-port guard (every port listening
#     before the run and every host off this machine is refused);
#  4. dashboard tsc on the merged tree, then the four dashboard suites of the
#     a2870083 check, under the same guards (main changed no dashboard file).
S=/Volumes/Projects/.scratch-fa032fc0
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus
MAIN=$(git -C $N rev-parse 2a7952fcc63ea7b26d8148668c76800e73acc5c2^{commit}) || exit 1
BR=$(git -C $N rev-parse 6e14bc87^{commit}) || exit 1
BASE=bd02642895fe6a914fe04e45af35bee773f3453e
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== TheNexus: main pinned at $MAIN, branch code head $BR, base ${BASE:0:8}"
echo "main now: $(git -C $N rev-parse --short=8 main); branch head now: $(git -C $N rev-parse --short=8 HEAD)"
echo "files the branch changed after ${BR:0:8} outside the evidence folder: $(git -C $N diff --name-only $BR HEAD | grep -cv '^docs/reviews/2026-11-23-local-model-control-evidence/')"
OUT=$(git -C $N merge-tree --write-tree $MAIN $BR 2>&1); RC=$?
TREE=$(echo "$OUT" | head -1)
echo "merge-tree exit $RC (0 = merges without conflict); tree $TREE"
[ $RC -eq 0 ] || { echo "$OUT" | head -20; exit 1; }
echo "files both sides change since the base: $(comm -12 <(git -C $N diff --name-only $BASE $MAIN | sort) <(git -C $N diff --name-only $BASE $BR | sort) | tr '\n' ' ')"
echo "files main changed since a2870083: $(git -C $N diff --name-only a2870083 $MAIN | wc -l | tr -d ' '); shared with the branch: $(comm -12 <(git -C $N diff --name-only a2870083 $MAIN | sort) <(git -C $N diff --name-only $BASE $BR | sort) | tr '\n' ' ')"

M=$S/merged-nexus7
mkdir -p $M || exit 1
[ -z "$(ls -A $M)" ] || { echo "$M is not empty, stopping"; exit 1; }
git -C $N archive $MAIN | tar -x -C $M || { echo "archive failed"; exit 1; }
git -C $N diff --binary $BASE $BR > $S/nexus-branch7.patch
(cd $M && git apply --whitespace=nowarn $S/nexus-branch7.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/nexus-branch7.patch) files"
T=$(mktemp)
git -C $N ls-tree -r $TREE | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $T
echo "merged-nexus7 against the merge-tree's tree: $(wc -l < $T | tr -d ' ') tracked files compared, $(paste <(cut -f1 $T) <(cut -f2 $T | (cd $M && git hash-object --no-filters --stdin-paths)) | awk '$1!=$2' | wc -l | tr -d ' ') differ, $(cd $M && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $T | sort) | wc -l | tr -d ' ') extra files in the copy; symlinks in the tree: $(git -C $N ls-tree -r $TREE | awk '$1=="120000"' | wc -l | tr -d ' ')"
rm -f $T
ln -s $N/node_modules $M/node_modules
ln -s $N/dashboard/node_modules $M/dashboard/node_modules

guard_env() { # tag
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-$1.txt
  : > $S/lmstudio-guard-$1.log; : > $S/live-port-guard-$1.log; rm -f $S/net-guard-$1.log
  echo "LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-$1.log NET_GUARD_LOG=$S/net-guard-$1.log LIVE_PORTS_FILE=$S/live-ports-$1.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-$1.log"
}
GUARD_IMPORTS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs"
guard_counts() { # tag
  echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-$1.log | tr -d ' ') net=$(cat $S/net-guard-$1.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-$1.log | tr -d ' ') (live ports before the run: $(wc -l < $S/live-ports-$1.txt | tr -d ' '))"
}

SUITES=""
for t in astro-nightly-backfill astro-nightly board-summary calendar-model-control cortex-role-seeds local-model-selection \
  local-model-work local-operator-flows mail-draft-auth-mount maintenance-auth-mount model-control-db model-control-resolver \
  model-control-route model-roles model-rows-migration operator-confirmation presentations provenance-trust-boundaries \
  retired-orchestration studio-ingestion studio-route task-dispatch-auth-mount tasks-model-control \
  document-chat-retirement document-retirement-grounds-store document-retirements document-revision-cancellation \
  document-relocations; do
  [ -f $M/server/__tests__/$t.test.js ] || echo "MISSING on the merged tree: $t"
  SUITES="$SUITES server/__tests__/$t.test.js"
done
echo "== server suites: $(echo $SUITES | wc -w | tr -d ' ')"
GE=$(guard_env nexus-merged7)
(cd $M && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 $GE NODE_OPTIONS="$GUARD_IMPORTS" \
  npx jest $SUITES --cacheDirectory $S/jest-cache-merged7 > $S/nexus-merged7-tests.txt 2>&1; echo "exit $?" >> $S/nexus-merged7-tests.txt)
grep -E "^Tests:|^Test Suites:|^exit" $S/nexus-merged7-tests.txt
grep -E "^FAIL " $S/nexus-merged7-tests.txt
guard_counts nexus-merged7

echo "== dashboard"
(cd $M/dashboard && node $N/dashboard/node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json > $S/dashboard-tsc-merged7.txt 2>&1; echo "exit $?" >> $S/dashboard-tsc-merged7.txt)
echo "dashboard tsc: $(tail -1 $S/dashboard-tsc-merged7.txt) ($(grep -c 'error TS' $S/dashboard-tsc-merged7.txt) errors)"
DASH_TESTS="src/components/__tests__/local-model-chooser.test.mjs src/components/__tests__/chat-model-control.test.mjs src/lib/__tests__/fast-refresh-boundaries.test.ts src/components/__tests__/document-retirements.test.mjs"
for f in $DASH_TESTS; do [ -f "$M/dashboard/$f" ] || echo "MISSING on the merged tree: $f"; done
GE=$(guard_env dashboard-merged7)
(cd $M/dashboard && env $GE NODE_OPTIONS="$GUARD_IMPORTS" node --import ./test/register.mjs --test $DASH_TESTS > $S/dashboard-merged7-tests.txt 2>&1; echo "exit $?" >> $S/dashboard-merged7-tests.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/dashboard-merged7-tests.txt | tr '\n' ' '; echo
grep -E "^✖ " $S/dashboard-merged7-tests.txt | grep -v "failing tests" | head -10
guard_counts dashboard-merged7
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
