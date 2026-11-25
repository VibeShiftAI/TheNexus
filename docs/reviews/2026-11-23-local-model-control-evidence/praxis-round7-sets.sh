#!/bin/bash
# The Praxis sets of rounds 5 and 6, rerun on the round-7 head 196a5375 (the
# clean worktree), one after another under praxis-files-guarded.sh (the LM Studio
# guard, the network guard, the live-port guard, the fake lms and the CLI shims):
#   selection-r7:    local_model_selection, local_model_demand_callers, local_lane_policy
#   related-r7:      the 40 related files (praxis-round5-related-names.txt)
#   more-related-r7: the 9 more-related files of round 4 plus lane_credit
#                    (praxis-round5-more-related-names.txt)
#   wider-r7:        praxis-wider-run.sh (the 41 names of praxis-wider-test-list.txt
#                    less maintenance_review_regressions, which makes its data
#                    folder under /Volumes)
# Round 7 changed src/llm/lmstudio-autoload.ts and the test file
# local_model_selection, which is in the selection and related sets; every test
# file that names lmstudio-autoload is in one of the lists
# (praxis-round6-importers.txt, whose pattern includes it). The head is printed
# before and after, and the run stops if the worktree is not clean at 196a5375.
# Before running it, copy guards/ into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
[ -e $S/praxis-files-guarded.sh ] || { echo "$S/praxis-files-guarded.sh is missing: copy guards/ into $S first"; exit 1; }
[ "$(git -C $P rev-parse HEAD)" = 196a537506d8b9076753ee1143cd527c3ac6eb14 ] || { echo "the Praxis worktree is not at 196a5375, stopping"; exit 1; }
[ -z "$(git -C $P status --porcelain)" ] || { echo "the Praxis worktree has changes, stopping"; exit 1; }
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Praxis head: $(git -C $P log -1 --format=%H)"
bash $S/praxis-files-guarded.sh $P selection-r7 local_model_selection local_model_demand_callers local_lane_policy
bash $S/praxis-files-guarded.sh $P related-r7 $(tr '\n' ' ' < $E/praxis-round5-related-names.txt)
bash $S/praxis-files-guarded.sh $P more-related-r7 $(tr '\n' ' ' < $E/praxis-round5-more-related-names.txt) lane_credit
TAG=wider-r7 bash $E/praxis-wider-run.sh
echo "== tsc"
{
  echo "# npx tsc --noEmit in $P"
  echo "# started $(date '+%Y-%m-%d %H:%M:%S %Z'), head $(git -C $P rev-parse --short=8 HEAD), working tree: $(git -C $P status --porcelain | wc -l | tr -d ' ') changed files"
  (cd $P && npx tsc --noEmit 2>&1; echo "exit $?")
  echo "# finished $(date '+%H:%M:%S %Z')"
} > $S/praxis-tsc-r7.txt
cat $S/praxis-tsc-r7.txt
echo "Praxis head after: $(git -C $P log -1 --format=%H); working tree: $(git -C $P status --porcelain | wc -l | tr -d ' ') changed files"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
