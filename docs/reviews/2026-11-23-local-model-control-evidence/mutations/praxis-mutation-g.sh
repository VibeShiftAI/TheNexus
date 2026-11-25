#!/bin/bash
# Mutation G: planFrom ignores Nexus's waiting flag again (the condition before the fix).
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
D=$S/praxis-mut-g
rm -rf "$D" && mkdir -p "$D"
git -C $P archive HEAD | tar -x -C "$D"
git -C $P diff --binary > $S/praxis-wip.patch
(cd "$D" && git apply --whitespace=nowarn $S/praxis-wip.patch) || { echo "apply failed"; exit 1; }
ln -s $P/node_modules "$D/node_modules"
F="$D/src/llm/local-model-selection.ts"
perl -0pi -e 's/const waitingChoice = current\.waiting === true \|\| \(/const waitingChoice = (/' "$F"
echo "== mutation g: $(grep -c 'current.waiting === true' "$F") original conditions left"
: > $S/lmstudio-guard-mut.log; rm -f $S/net-guard-mut.log
(cd "$D" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" npm test -- tests/local_model_selection.test.ts > $S/praxis-mutation-g.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-g.txt)
grep -E "^ℹ (tests|pass|fail)|^exit" $S/praxis-mutation-g.txt
grep -E "✖ " $S/praxis-mutation-g.txt | grep -v "failing tests" | sort -u | head -5
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log) net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l)"
