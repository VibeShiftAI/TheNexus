#!/bin/bash
# Task fa032fc0: the TheNexus test that assumed Inkling has no models row (main's
# seed from the readiness task lists it) now uses a model no seed lists, and test
# 468 checks the free id. Runs: the suite on the branch, the 23 suites on the
# merged tree (main + branch incl. this uncommitted change), and mutations H, V, W.
S=/Volumes/Projects/.scratch-fa032fc0
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus

echo "== branch worktree: local-model-selection.test.js"
rm -f $S/net-guard-seedfix.log
(cd $N && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-seedfix.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest server/__tests__/local-model-selection.test.js --cacheDirectory $S/jest-cache > $S/nexus-selection-seedfix.txt 2>&1; echo "exit $?" >> $S/nexus-selection-seedfix.txt)
grep -E "^Tests:|^exit" $S/nexus-selection-seedfix.txt | tr '\n' ' '; echo
grep -E "✕" $S/nexus-selection-seedfix.txt | head -6
echo "net refusals: $(cat $S/net-guard-seedfix.log 2>/dev/null | wc -l | tr -d ' ')"

echo "== merged tree: main $(git -C $N rev-parse --short main) + branch working tree vs bd02642"
M=$S/merged-main
for l in "$M/node_modules" "$M/dashboard/node_modules"; do [ -L "$l" ] && rm -f "$l"; done
rm -rf "$M" && mkdir -p "$M"
git -C $N archive main | tar -x -C "$M" || { echo "archive failed"; exit 1; }
git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e > $S/branch-vs-baseline-wt.patch
(cd "$M" && git apply --whitespace=nowarn $S/branch-vs-baseline-wt.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/branch-vs-baseline-wt.patch) files"
ln -s $N/node_modules "$M/node_modules"
NEXUS_SUITES=""
for t in astro-nightly-backfill astro-nightly board-summary calendar-model-control cortex-role-seeds local-model-selection \
  local-model-work local-operator-flows mail-draft-auth-mount maintenance-auth-mount model-control-db model-control-resolver \
  model-control-route model-roles model-rows-migration operator-confirmation presentations provenance-trust-boundaries \
  retired-orchestration studio-ingestion studio-route task-dispatch-auth-mount tasks-model-control; do
  NEXUS_SUITES="$NEXUS_SUITES server/__tests__/$t.test.js"
done
rm -f $S/net-guard-merged4.log
(cd "$M" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-merged4.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest $NEXUS_SUITES --cacheDirectory $S/jest-cache-merged > $S/nexus-merged-main4-tests.txt 2>&1; echo "exit $?" >> $S/nexus-merged-main4-tests.txt)
grep -E "^Tests:|^Test Suites:|^exit" $S/nexus-merged-main4-tests.txt | tr '\n' ' '; echo
grep -E "^FAIL " $S/nexus-merged-main4-tests.txt | sort -u
echo "network guard refusals: $(cat $S/net-guard-merged4.log 2>/dev/null | wc -l | tr -d ' ')"

D=$S/nexus-mut-vw
for l in "$D/node_modules"; do [ -L "$l" ] && rm -f "$l"; done
rm -rf "$D" && mkdir -p "$D"
git -C $N archive HEAD | tar -x -C "$D"
git -C $N diff --binary > $S/nexus-wip.patch
(cd "$D" && git apply --whitespace=nowarn $S/nexus-wip.patch) || { echo "apply failed"; exit 1; }
ln -s $N/node_modules "$D/node_modules"
F="$D/server/services/local-model-selection.js"
run_mutation() {
  local name="$1" expr="$2"
  cp "$F" "$F.orig"
  perl -0pi -e "$expr" "$F"
  if cmp -s "$F" "$F.orig"; then echo "== mutation $name: NOT APPLIED"; mv "$F.orig" "$F"; return; fi
  echo "== mutation $name: applied"
  rm -f $S/net-guard-mut-nx.log
  (cd "$D" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-mut-nx.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
    npx jest server/__tests__/local-model-selection.test.js --cacheDirectory $S/jest-cache-mut > $S/nexus-mutation-$name.txt 2>&1; echo "exit $?" >> $S/nexus-mutation-$name.txt)
  grep -E "^Tests:|^exit" $S/nexus-mutation-$name.txt | tr '\n' ' '; echo
  grep -E "✕" $S/nexus-mutation-$name.txt | sed 's/ ([0-9]* ms)$//' | head -6
  echo "net refusals: $(cat $S/net-guard-mut-nx.log 2>/dev/null | wc -l | tr -d ' ')"
  mv "$F.orig" "$F"
}
# H (again, on the new test): choosing makes the row.
run_mutation h2 's/const known = await findLocalModelRow\(row\.key\);/const known = await ensureLocalModelRow({ key: row.key, label, reasoning: !!row.capabilities?.reasoning });/'
# V: a new row takes the derived id even when another row has it.
run_mutation v 's/        for \(let n = 2; taken\.has\(id\); n \+= 1\) id = `\$\{base\}-\$\{n\}`;\n//'
# W: the new row drops LM Studio's reasoning flag.
run_mutation w 's/capabilities: \{ chat: true, local: true, \.\.\.\(reasoning \? \{ reasoning: true \} : \{\}\) \},/capabilities: { chat: true, local: true },/'
echo "== done"
