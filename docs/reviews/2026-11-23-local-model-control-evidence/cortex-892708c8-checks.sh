#!/bin/bash
# TheCortex at the task branch head 892708c8, run on the clean worktree:
#  1. tests/test_local_model_setting.py, verbose;
#  2. the 11 offline test files of the earlier checks (merged-main/merged-main-check.sh);
#  3. tests/test_local_model_setting.py 25 times in a row, as before the commit
#     (the new tests run threads that wait on one another, so a timing fault
#     would show as a failure in some of the runs).
# Every run goes through cortex-tests.sh: every service URL on port 1, the
# offline network plugin, the conftest's store guard, no pytest cache and no
# bytecode written. Before running it, copy guards/ into the scratch folder (see
# the README).
S=/Volumes/Projects/.scratch-fa032fc0
C=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheCortex
WANT=892708c8df06133e9b545962ac82575ec7eea9c0
[ -e $S/cortex-tests.sh ] || { echo "$S/cortex-tests.sh is missing: copy guards/ into $S first"; exit 1; }
[ "$(git -C $C rev-parse HEAD)" = "$WANT" ] || { echo "the TheCortex worktree is not at $WANT, stopping"; exit 1; }
[ -z "$(git -C $C status --porcelain)" ] || { echo "the TheCortex worktree has changes, stopping: this check runs only the committed head"; exit 1; }
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), TheCortex $(git -C $C rev-parse --short=8 HEAD), worktree clean"
touch $S/cortex-892708c8-checks.marker

bash $S/cortex-tests.sh $C/TheCortex $S/cortex-local-model-tests-892708c8.txt -vv tests/test_local_model_setting.py
echo "1. test_local_model_setting.py, verbose: $(grep -E '^=+ .*(passed|failed).* =+$|^exit=' $S/cortex-local-model-tests-892708c8.txt | tr '\n' ' ')"

bash $S/cortex-tests.sh $C/TheCortex $S/cortex-offline-tests-892708c8.txt tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py \
  tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py tests/test_praxis_local_llm_route.py tests/test_client_embedder.py \
  python/test_acted_on_retrieval.py python/test_packet_format.py python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py
echo "2. the 11 offline files: $(grep -E '(passed|failed)|^exit=' $S/cortex-offline-tests-892708c8.txt | tail -2 | tr '\n' ' ')"

R=$S/cortex-local-model-repeat-892708c8.txt
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), TheCortex $(git -C $C rev-parse --short=8 HEAD)" > $R
for i in $(seq 1 25); do
  bash $S/cortex-tests.sh $C/TheCortex $S/cortex-repeat-one.txt tests/test_local_model_setting.py
  echo "run $i: $(grep -E '(passed|failed)|^exit=' $S/cortex-repeat-one.txt | tail -2 | tr '\n' ' ')" >> $R
done
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')" >> $R
echo "3. 25 runs: $(grep -c 'run [0-9]*: 26 passed.* exit=0' $R) of them 26 passed with exit 0"

echo "the worktree after the runs: head $(git -C $C rev-parse --short=8 HEAD), $(git -C $C status --porcelain | wc -l | tr -d ' ') changed or untracked files, $(find $C -newer $S/cortex-892708c8-checks.marker -type f -not -path '*/.git/*' | wc -l | tr -d ' ') files written since the start"
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since the start: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/cortex-892708c8-checks.marker | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
