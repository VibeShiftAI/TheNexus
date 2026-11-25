#!/bin/bash
# Mutations U and L2 of where chatVia starts counting a local call.
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
  echo "== mutation $name ($file): applied; insideCountedLocalCall lines: $(grep -n 'insideCountedLocalCall()' "$F" | cut -d: -f1 | tr '\n' ' ')"
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
# U: count from chatVia's entry again, before the lane decision (the placement before this fix).
run_mutation u src/llm/manager.ts 's/\n      if \(!insideCountedLocalCall\(\)\) \{\n(?:        \/\/[^\n]*\n)+        return trackLocalCall\(\(\) => this\.chatVia\(providerName, model, params, options\)\);\n      \}\n/\n/; s/(  \): Promise<OpenAI\.ChatCompletion> \{\n)(    if \(isEvalCaller\(options\?\.caller\)\) \{\n      assertEvalModelAllowed\(model\);)/$1    if (providerName === "local" && !insideCountedLocalCall()) return trackLocalCall(() => this.chatVia(providerName, model, params, options));\n$2/'
# L2: no counting in chatVia at all; only the provider wrapper counts, while LM Studio answers.
run_mutation l2 src/llm/manager.ts 's/      if \(!insideCountedLocalCall\(\)\) \{\n        \/\/ The call runs on LM Studio/      if (false) {\n        \/\/ The call runs on LM Studio/'
