#!/bin/bash
# Task fa032fc0, Praxis round-4 fixes: mutations s1-s7, one per fix, each in a
# scratch copy (git archive HEAD plus the uncommitted fixes) outside every
# repository, run with the same guards as every Praxis run.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
D=$S/praxis-mut-s
mkdir -p "$D" && [ -z "$(ls -A "$D")" ] || { echo "$D is not empty, stopping"; exit 1; }
git -C $P archive HEAD | tar -x -C "$D"
git -C $P diff --binary > $S/praxis-wip-r4.patch
(cd "$D" && git apply --whitespace=nowarn $S/praxis-wip-r4.patch) || { echo "apply failed"; exit 1; }
echo "copy: HEAD $(git -C $P rev-parse --short HEAD) plus $(grep -c '^diff --git' $S/praxis-wip-r4.patch) changed files"
ln -s $P/node_modules "$D/node_modules"
run_mutation() {
  local name="$1" file="$2" expr="$3"
  local F="$D/$file"
  cp "$F" "$F.orig"
  perl -0pi -e "$expr" "$F"
  if cmp -s "$F" "$F.orig"; then echo "== mutation $name: NOT APPLIED"; mv "$F.orig" "$F"; return; fi
  echo "== mutation $name ($file): applied"
  diff "$F.orig" "$F" | sed 's/^/   /'
  : > $S/lmstudio-guard-mut.log; rm -f $S/net-guard-mut.log
  (cd "$D" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
    PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
    NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
    npm test -- tests/local_model_selection.test.ts tests/local_model_primary.test.ts > $S/praxis-mutation-$name.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-$name.txt)
  grep -E "^ℹ (tests|pass|fail)|^exit" $S/praxis-mutation-$name.txt | tr '\n' ' '; echo
  grep -E "^✖ " $S/praxis-mutation-$name.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u
  echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log | tr -d ' ') net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l | tr -d ' ')"
  mv "$F.orig" "$F"
}
# s1: refuse after any wait for a switch being recorded (the rule before this fix), whether or not it switched anything.
run_mutation s1 src/llm/lmstudio-autoload.ts 's/const switchesBefore = localModelSwitchCount\(\);\n  for \(let switching = localModelApplyInProgress\(\); switching; switching = localModelApplyInProgress\(\)\) \{\n/let waited = false;\n  const switchesBefore = localModelSwitchCount();\n  for (let switching = localModelApplyInProgress(); switching; switching = localModelApplyInProgress()) {\n    waited = true;\n/; s/\(s\.seq \?\? 0\) > switchesBefore/waited \&\& switchesBefore >= 0/'
# s2: only the model the latest switch replaced may skip the idle period (the single record before this fix).
run_mutation s2 src/llm/lmstudio-autoload.ts 's/\? \[switchedAway\] : switchedAway;/? [switchedAway] : switchedAway.slice(-1);/'
# s3: a new spelling of the model in effect is recorded as a switch.
run_mutation s3 src/llm/local-model-selection.ts 's/if \(!sameModel\(previous, model\)\) noteLocalModelSwitch/noteLocalModelSwitch/'
# s4: entries for the model chosen again are dropped only when spelled exactly the same.
run_mutation s4 src/llm/local-model-state.ts 's/!sameModel\(s\.model, previous\) && !sameModel\(s\.model, next\)/s.model !== previous \&\& s.model !== next/'
# s5: chat() counts each attempt on its own again, not the primary's attempts as one call.
run_mutation s5 src/llm/manager.ts 's/const primary = this\.activeProvider === "local" \? await trackLocalCall\(tryPrimary\) : await tryPrimary\(\);/const primary = await tryPrimary();/'
# s6: the output-room wrapper outside the count again (the order before this fix).
run_mutation s6 src/llm/manager.ts 's/return trackedLocalProvider\(withOutputRoom\(provider\)\);/return withOutputRoom(trackedLocalProvider(provider));/'
# s7: a streamed local primary keeps the model read when the candidate list was built.
run_mutation s7 src/llm/manager.ts 's/const model = followsLocalModel \? config\.localLlmModel : listedModel;/const model = listedModel;/'
echo "== done"
