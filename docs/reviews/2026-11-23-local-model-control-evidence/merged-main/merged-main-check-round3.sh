#!/bin/bash
# Task fa032fc0, after the delta-review fixes (TheNexus 6e14bc87, TheCortex
# e611edc): each branch diff against its baseline applied to `git archive main`
# outside every repository, with the same guards as before. The dashboard has
# not changed since e1bfcc97 and Praxis was checked against 4d076f91 already.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
N=$W/TheNexus
C=$W/TheCortex
empty_dir() { mkdir -p "$1" && [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }

echo "== TheNexus: main $(git -C $N rev-parse --short main), branch $(git -C $N rev-parse --short HEAD), base bd02642"
M=$S/merged-main4
empty_dir "$M"
git -C $N archive main | tar -x -C "$M" || { echo "archive failed"; exit 1; }
git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e HEAD > $S/branch-vs-baseline4.patch
(cd "$M" && git apply --whitespace=nowarn $S/branch-vs-baseline4.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/branch-vs-baseline4.patch) files"
ln -s $N/node_modules "$M/node_modules"
NEXUS_SUITES=""
for t in astro-nightly-backfill astro-nightly board-summary calendar-model-control cortex-role-seeds local-model-selection \
  local-model-work local-operator-flows mail-draft-auth-mount maintenance-auth-mount model-control-db model-control-resolver \
  model-control-route model-roles model-rows-migration operator-confirmation presentations provenance-trust-boundaries \
  retired-orchestration studio-ingestion studio-route task-dispatch-auth-mount tasks-model-control; do
  NEXUS_SUITES="$NEXUS_SUITES server/__tests__/$t.test.js"
done
echo "server suites named: $(echo $NEXUS_SUITES | wc -w | tr -d ' ')"
rm -f $S/net-guard-merged4.log
(cd "$M" && env -u YOUTUBE_API_KEY -u GOOGLE_API_KEY NET_GUARD_LOG=$S/net-guard-merged4.log NODE_OPTIONS="--import=file://$S/net-guard.mjs" \
  npx jest $NEXUS_SUITES --cacheDirectory $S/jest-cache-merged > $S/nexus-merged-main5-tests.txt 2>&1; echo "exit $?" >> $S/nexus-merged-main5-tests.txt)
grep -E "^Tests:|^Test Suites:|^exit" $S/nexus-merged-main5-tests.txt
grep -E "^FAIL " $S/nexus-merged-main5-tests.txt
echo "network guard refusals: $(cat $S/net-guard-merged4.log 2>/dev/null | wc -l | tr -d ' ')"

echo "== TheCortex: main $(git -C $C rev-parse --short main), branch $(git -C $C rev-parse --short HEAD), base 5fdb76a"
MC=$S/merged-cortex4
empty_dir "$MC"
git -C $C archive main | tar -x -C "$MC" || { echo "archive failed"; exit 1; }
git -C $C diff --binary 5fdb76a HEAD > $S/cortex-branch4.patch
(cd "$MC" && git apply --whitespace=nowarn $S/cortex-branch4.patch) || { echo "CORTEX APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/cortex-branch4.patch) files"
ln -s $C/TheCortex/.env "$MC/TheCortex/.env"
grep -n "cortex_test_guard.install\|def local_model_setting_offline" "$MC/TheCortex/conftest.py"
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merged-main4-tests.txt tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py \
  tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py tests/test_praxis_local_llm_route.py tests/test_client_embedder.py \
  python/test_acted_on_retrieval.py python/test_packet_format.py python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py
grep -E "passed|failed|error|exit=" $S/cortex-merged-main4-tests.txt | tail -3
echo "== done"
