#!/bin/bash
# Round 6 mutations: each takes one part of the round-6 fixes (the five items the
# review of round 5 found) out of a scratch copy of Praxis bd19e926 and runs the
# suites the round-6 tests are in, under the same guards as every Praxis run here
# (LM Studio guard, network guard, live-port guard, fake lms, CLI shims). The diff
# each mutation made is printed before its result, so what was removed can be
# read here.
#   s1:    spoken prose passes the count read with its model (finding 1)
#   s2:    the member-profile drain gives its extractor the model as a function (finding 2)
#   s3-s4: the streamed role candidate and the credit reroute pass the count read
#          with their model (finding 3)
#   s5-s7: the refusal names the switch that replaced the model, and whether it
#          took effect during the claim's own wait (finding 4)
#   s8:    primaryForTest restores the manager's model as well as its provider
#          (finding 5). chat()'s fallback keeps the primary when the environment
#          sets LLM_PRIMARY_PROVIDER and LLM_PRIMARY_MODEL to a registered provider,
#          as this shell does, and test runs do not load Praxis's .env, so s8 and a
#          control run once more with those two variables unset.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
HEAD_UNDER_TEST=bd19e926a16509bd213f49c20f4c95bed95a43e9
SUITES="tests/local_model_selection.test.ts tests/member_profile_updates.test.ts tests/spoken_prose.test.ts tests/local_model_demand_callers.test.ts"
D=$S/praxis-mut-r6
rm -rf "$D" && mkdir -p "$D"
git -C $P archive $HEAD_UNDER_TEST | tar -x -C "$D"
ln -s $P/node_modules "$D/node_modules"
echo "Praxis under test: $HEAD_UNDER_TEST (scratch copy $D)"
echo "suites: $SUITES"

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
  find "$D/src" "$D/tests" -name '*.orig' | while read -r f; do mv "$f" "${f%.orig}"; done
}
run() { # name [env -u flags]
  local name=$1; shift
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-mut.txt
  : > $S/lmstudio-guard-mut.log; : > $S/live-port-guard-mut.log; : > $S/cli-shims.log; rm -f $S/net-guard-mut.log
  (cd "$D" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY "$@" LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
    PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
    PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-mut.log NET_GUARD_LOG=$S/net-guard-mut.log \
    LIVE_PORTS_FILE=$S/live-ports-mut.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-mut.log \
    NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
    npm test -- $SUITES > $S/praxis-mutation-r6-$name.txt 2>&1; echo "exit $?" >> $S/praxis-mutation-r6-$name.txt)
  echo "   result: $(grep -E "^ℹ (tests|pass|fail|cancelled)|^exit" $S/praxis-mutation-r6-$name.txt | tr '\n' ' ')"
  grep -E "^✖ " $S/praxis-mutation-r6-$name.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | sed 's/^/   /'
  # A failing after() hook is reported apart from the tests; show its message.
  grep -E "the manager's primary is as it was before the suite" $S/praxis-mutation-r6-$name.txt | head -2 | sed 's/^ */   hook: /'
  echo "   guards: lmstudio=$(wc -l < $S/lmstudio-guard-mut.log | tr -d ' ') net=$(cat $S/net-guard-mut.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-mut.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims.log | tr -d ' ')"
  restore
}

echo "== control: no mutation"
run control

echo "== s1: spoken prose does not pass the count of switches it read with the model"
apply src/voice/spoken-prose.ts 's/, deadlineAt, localModelSwitches: localModelSwitchCount\(\) \}\);/, deadlineAt });/' && run s1

echo "== s2: the member-profile drain gives its extractor the model read once, as a plain string"
apply src/council/member-profile-updates.ts 's/model: \(\) => config\.localLlmModel \}\);/model: config.localLlmModel });/' && run s2

echo "== s3: chatStream takes a fresh count for every local candidate, the role's included"
apply src/llm/manager.ts 's/followsLocalModel \|\| resolvedSwitches === undefined \? localModelSwitchCount\(\) : resolvedSwitches/localModelSwitchCount()/' && run s3

echo "== s4: the credit reroute does not pass the count read with its model"
apply src/llm/manager.ts 's/abortAtDeadline: options\?\.abortAtDeadline, localModelSwitches \}/abortAtDeadline: options?.abortAtDeadline }/' && run s4

echo "== s5: the refusal names the model in effect, not the one the switch that replaced the call's model made"
apply src/llm/lmstudio-autoload.ts 's/const chosen = claim\.replacedBy \?\? expectedLocalModel\(\) \?\? "the chosen model";/const chosen = expectedLocalModel() ?? "the chosen model";/' && run s5

echo "== s6: the refusal says the call waited whenever a switch was being recorded when it arrived (the a8caeb09 rule)"
apply src/llm/lmstudio-autoload.ts 's/\n  const claim = await claimLocalSlot\(trigger, requestedModel, deps, wait\);\n/\n  const waitedForSwitch = localModelApplyInProgress() !== null;\n  const claim = await claimLocalSlot(trigger, requestedModel, deps, wait);\n/; s/\n      claim\.duringWait\n/\n      waitedForSwitch\n/' && run s6

echo "== s7: the claim decides duringWait from the caller's count instead of the count when the claim began"
apply src/llm/lmstudio-autoload.ts 's/duringWait: \(replaced\.seq \?\? 0\) > switchesAtClaim,/duringWait: (replaced.seq ?? 0) > switchesBefore,/' && run s7

echo "== s8: primaryForTest restores the manager's provider only (the round-5 helper), environment as in every run"
apply tests/local_model_selection.test.ts 's/\n    manager\.activeModel = before\.model;\n/\n/' && run s8

echo "== control-no-primary: no mutation, LLM_PRIMARY_PROVIDER and LLM_PRIMARY_MODEL unset"
run control-no-primary -u LLM_PRIMARY_PROVIDER -u LLM_PRIMARY_MODEL

echo "== s8-no-primary: primaryForTest restores the provider only, LLM_PRIMARY_PROVIDER and LLM_PRIMARY_MODEL unset"
apply tests/local_model_selection.test.ts 's/\n    manager\.activeModel = before\.model;\n/\n/' && run s8-no-primary -u LLM_PRIMARY_PROVIDER -u LLM_PRIMARY_MODEL

restore
echo "== scratch copy left at $D for inspection; deleted with the scratch folder"
