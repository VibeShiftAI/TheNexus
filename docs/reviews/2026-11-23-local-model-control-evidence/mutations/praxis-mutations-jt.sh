#!/bin/bash
# Mutations J..T of the review fixes, one scratch copy of the Praxis branch tree
# (HEAD + uncommitted diff + the new untracked test), each mutation applied to a
# pristine file and restored before the next.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
D=$S/praxis-mut-jt
rm -rf "$D" && mkdir -p "$D"
git -C $P archive HEAD | tar -x -C "$D"
git -C $P diff --binary > $S/praxis-wip.patch
(cd "$D" && git apply --whitespace=nowarn $S/praxis-wip.patch) || { echo "apply failed"; exit 1; }
cp $P/tests/local_model_primary.test.ts "$D/tests/local_model_primary.test.ts"
ln -s $P/node_modules "$D/node_modules"

run_mutation() {
  local name="$1" file="$2" expr="$3"
  local F="$D/$file"
  cp "$F" "$F.orig"
  perl -0pi -e "$expr" "$F"
  if cmp -s "$F" "$F.orig"; then echo "== mutation $name: NOT APPLIED"; mv "$F.orig" "$F"; return; fi
  echo "== mutation $name ($file): applied"
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

# J: the primary keeps LLM_PRIMARY_MODEL instead of following the setting.
run_mutation j src/llm/manager.ts 's/return this\.activeProvider === "local" \? config\.localLlmModel : this\.activeModel;/return this.activeModel;/'
# K: the worker writes the calendar entry before the job is counted (the gap before the fix).
run_mutation k src/local-llm/worker.ts 's/      const run = async \(\) => \{\n        await this\.calendarSync\.updateForJob\(claimed\);\n/      await this.calendarSync.updateForJob(claimed);\n      const run = async () => {\n/'
# L: chatVia counts a pinned local call only while LM Studio answers.
run_mutation l src/llm/manager.ts 's/if \(providerName === "local" && !insideCountedLocalCall\(\)\) \{/if (false && providerName === "local" \&\& !insideCountedLocalCall()) {/'
# M: a call made inside a counted call is counted again.
run_mutation m src/llm/local-lane-policy.ts 's/  if \(countedCall\.getStore\(\)\) return run\(\);\n//'
# N: a call naming the waiting model reloads the model in effect on an empty slot.
run_mutation n src/llm/manager.ts 's/if \(model === waitingLocalModel\(\)\) \{/if (false \&\& model === waitingLocalModel()) {/'
# O: a call that waited for the apply and names the replaced model is sent anyway.
run_mutation o src/llm/lmstudio-autoload.ts 's/if \(waitedForSwitch && away && requestedModel === away\.model/if (false \&\& waitedForSwitch \&\& away \&\& requestedModel === away.model/'
# P: the busy answer is logged every time Praxis asks.
run_mutation p src/llm/local-model-selection.ts 's/if \(workLabel\(outcome\.waitingFor\) !== workLabel\(p\.nexusWaitingFor\)\) \{/if (true) {/'
# Q: an older answer is acted on after a newer one.
run_mutation q src/llm/local-model-selection.ts 's/  if \(read < newestReadActedOn\) return localModelSelectionSnapshot\(\);\n//'
# R: the read-back switches to Praxis's spelling, not Nexus's.
run_mutation r src/llm/local-model-selection.ts 's/localModelKey\(active\) === localModelKey\(model\) \? active : null;/localModelKey(active) === localModelKey(model) ? model : null;/'
# R2: the read-back compares names exactly.
run_mutation r2 src/llm/local-model-selection.ts 's/active !== null && localModelKey\(active\) === localModelKey\(model\) \?/active !== null \&\& active === model ?/'
# T: planFrom goes back to the rule before (flag OR differing names).
run_mutation t src/llm/local-model-selection.ts 's/typeof current\.waiting === "boolean"\n      \? current\.waiting\n      : current\.selected !== null/current.waiting === true || current.selected !== null/'
# G2: planFrom ignores Nexus's waiting flag altogether.
run_mutation g2 src/llm/local-model-selection.ts 's/typeof current\.waiting === "boolean"\n      \? current\.waiting\n      : current\.selected !== null/current.selected !== null/'
