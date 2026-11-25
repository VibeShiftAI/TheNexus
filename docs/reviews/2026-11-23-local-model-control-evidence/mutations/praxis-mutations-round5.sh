#!/bin/bash
# Review round 5 mutations: each takes one part of the round-5 fixes out of a
# scratch copy of Praxis a8caeb09 and runs the three suites the new tests are in,
# under the same guards as every Praxis run here (LM Studio guard, network guard,
# live-port guard, fake lms, CLI shims). The diff each mutation made is printed
# before its result, so what was removed can be read here.
#   n1-n8: the count of switches taken where a call reads its model (finding 1)
#   m1-m3: work a counted call starts and leaves running is counted (finding 2)
#   mp:    the member-profile extractor reads the model at each extraction
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
HEAD_UNDER_TEST=a8caeb0943e83bfeac10671cc019f59a499c8277
D=$S/praxis-mut-r5
rm -rf "$D" && mkdir -p "$D"
git -C $P archive $HEAD_UNDER_TEST | tar -x -C "$D"
ln -s $P/node_modules "$D/node_modules"
echo "Praxis under test: $HEAD_UNDER_TEST (scratch copy $D)"

apply() { # file perl-expression
  local F="$D/$1"
  [ -f "$F.orig" ] || cp "$F" "$F.orig"
  local before
  before=$(cat "$F")
  perl -0pi -e "$2" "$F"
  # Each expression must change the file; one that matched nothing leaves the
  # copy as it was, and the mutation is skipped rather than run unchanged.
  if [ "$before" = "$(cat "$F")" ]; then echo "   NOT APPLIED to $1"; restore; return 1; fi
  diff -u "$F.orig" "$F" | tail -n +3 | sed "s|^|   $1 |"
}
restore() {
  find "$D/src" -name '*.orig' | while read -r f; do mv "$f" "${f%.orig}"; done
}
run() { # name
  local name=$1
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-mut.txt
  : > $S/lmstudio-guard-mut.log; : > $S/live-port-guard-mut.log; : > $S/cli-shims.log; rm -f $S/net-guard-mut.log
  (cd "$D" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
    PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
    PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
    LIVE_PORTS_FILE=$S/live-ports-mut.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-mut.log \
    NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
    npm test -- tests/local_model_selection.test.ts tests/local_model_demand_callers.test.ts tests/local_lane_policy.test.ts \
    > $S/praxis-mutation-r5-$name.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-r5-$name.txt)
  echo "   result: $(grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-mutation-r5-$name.txt | tr '\n' ' ')"
  grep -E "^✖ " $S/praxis-mutation-r5-$name.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | sed 's/^/   /'
  echo "   guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log | tr -d ' ') net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-mut.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims.log | tr -d ' ')"
  restore
}

echo "== control: no mutation"
run control

echo "== n1: the slot claim ignores the count the caller read and takes its own when it starts"
apply src/llm/lmstudio-autoload.ts 's/const switchesBefore = wait\.localModelSwitches \?\? localModelSwitchCount\(\);/const switchesBefore = localModelSwitchCount();/' && run n1

echo "== n2: the local provider's chat does not pass the count on to the claim"
apply src/llm/providers.ts 's/await claimSlot\(params\.model, \{ deadlineAt: localCallDeadline\(options, enteredAt\), \.\.\.switchesReadBy\(options\) \}\);/await claimSlot(params.model, { deadlineAt: localCallDeadline(options, enteredAt) });/' && run n2

echo "== n3: the local provider's chatStream does not pass the count on to the claim"
apply src/llm/providers.ts 's/await claimSlot\(params\.model, switchesReadBy\(options\)\);/await claimSlot(params.model, {});/' && run n3

echo "== n4: a local primary's attempt does not take the count with its model"
apply src/llm/manager.ts 's/const switchesRead = this\.activeProvider === "local" \? \{ localModelSwitches: localModelSwitchCount\(\) \} : \{\};/const switchesRead = {};/' && run n4

echo "== n5: chatVia does not pass the count on to the provider"
apply src/llm/manager.ts 's/this\.sendPinnedCall\(provider, providerName, model, params, options, assertBatchWindowOpen, \{ localModelSwitches \}\)/this.sendPinnedCall(provider, providerName, model, params, options, assertBatchWindowOpen, {})/' && run n5

echo "== n6: complete() does not pass on the count read with the role's model, so chatVia takes it on entry"
apply src/llm/manager.ts 's/\n        \/\/ When the role.s local model was read, not when chatVia is reached\.\n        \.\.\.\(resolved\.localModelSwitches === undefined \? \{\} : \{ localModelSwitches: resolved\.localModelSwitches \}\),\n/\n/' && run n6

echo "== n7: chatStream does not pass the count on to the provider"
apply src/llm/manager.ts 's/\{ cacheNamespaceSeed: this\.cacheNamespaceSeed\(pname, model\), \.\.\.switchesRead \}/{ cacheNamespaceSeed: this.cacheNamespaceSeed(pname, model) }/' && run n7

echo "== n8: role resolution does not take the count with the role's model"
apply src/llm/manager.ts 's/ : \{ \.\.\.target, \.\.\.\(target\.followsLocalModel \? \{ model: config\.localLlmModel \} : \{\}\), localModelSwitches: localModelSwitchCount\(\) \};/ : { ...target, ...(target.followsLocalModel ? { model: config.localLlmModel } : {}) };/' && run n8

echo "== m1: a call made inside a counted call is not counted at all (the round-4 counter)"
apply src/llm/local-lane-policy.ts 's/  const outer = countedCall\.getStore\(\);\n  if \(outer && outer\.open > 0\) \{\n    outer\.open \+= 1;\n    try \{\n      return await run\(\);\n    \} finally \{\n      endCountedRun\(outer\);\n    \}\n  \}\n/  if (countedCall.getStore()) return run();\n/' && run m1

echo "== m2: a call made inside an open counted call joins it without holding it open"
apply src/llm/local-lane-policy.ts 's/\n    outer\.open \+= 1;\n/\n/' && run m2

echo "== m3: chatVia does not count a local call made inside a counted call (the round-4 chatVia)"
apply src/llm/local-lane-policy.ts 's/(export function localCallsInFlight\(\): number \{)/export function insideCountedLocalCall(): boolean {\n  return countedCall.getStore() !== undefined;\n}\n\n$1/' \
  && apply src/llm/manager.ts 's/import \{ localModelSwitchCount, waitingLocalModel \} from "\.\/local-model-state\.js";/import { localModelSwitchCount, waitingLocalModel } from ".\/local-model-state.js";\nimport { insideCountedLocalCall } from ".\/local-lane-policy.js";/; s/return trackLocalCall\(\(\) => this\.sendPinnedCall\(provider, providerName, model, params, options, assertBatchWindowOpen, \{ localModelSwitches \}\)\);/if (insideCountedLocalCall()) return this.sendPinnedCall(provider, providerName, model, params, options, assertBatchWindowOpen, { localModelSwitches });\n      return trackLocalCall(() => this.sendPinnedCall(provider, providerName, model, params, options, assertBatchWindowOpen, { localModelSwitches }));/' \
  && run m3

echo "== mp: the member-profile extractor reads the model once, when it is made"
apply src/council/member-profile-updates.ts "s/  if \(!modelNow\(\)\.trim\(\)\) throw/  const madeWith = modelNow();\n  if (!madeWith.trim()) throw/; s/    const model = modelNow\(\);\n/    const model = madeWith;\n/" && run mp

restore
echo "== scratch copy left at $D for inspection; deleted with the scratch folder"
