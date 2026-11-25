#!/bin/bash
# Task fa032fc0, merge-conflict repair: the Praxis sets of round 7
# (praxis-round7-sets.sh), rerun unchanged on the merge commit 15b19a5c in the
# clean Praxis worktree, which is a real git checkout (the scratch copies of the
# merged checks have no .git, so the two suites that read git fail there, as on
# plain main). One after another under praxis-files-guarded.sh (the LM Studio
# guard, the network guard, the live-port guard, the fake lms and the CLI shims):
#   selection-mh:    local_model_selection, local_model_demand_callers, local_lane_policy
#   related-mh:      the 40 related files (praxis-round5-related-names.txt)
#   more-related-mh: the 9 more-related files of round 4 plus lane_credit
#                    (praxis-round5-more-related-names.txt)
#   wider-mh:        praxis-wider-run.sh, which reads its 41 names from
#                    praxis-manager-importers.txt in the scratch folder; this
#                    script copies praxis-wider-test-list.txt there under that
#                    name first (the runner leaves out maintenance_review_regressions,
#                    which makes its data folder under /Volumes)
# The head is printed before and after, and the run stops if the worktree is not
# clean at 15b19a5c. Before running it, copy guards/ into the scratch folder (see
# the README).
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
[ -e $S/praxis-files-guarded.sh ] || { echo "$S/praxis-files-guarded.sh is missing: copy guards/ into $S first"; exit 1; }
[ "$(git -C $P rev-parse HEAD)" = 15b19a5c147523c436b4f2783ca68c5e9e1c7843 ] || { echo "the Praxis worktree is not at 15b19a5c, stopping"; exit 1; }
[ -z "$(git -C $P status --porcelain)" ] || { echo "the Praxis worktree has changes, stopping"; exit 1; }
cp $E/praxis-wider-test-list.txt $S/praxis-manager-importers.txt
# The fake lms appends every call to the fixed lms-calls.log, which
# praxis-files-guarded.sh does not empty and praxis-wider-run.sh empties at its
# start; so it is emptied here and copied before the wider run.
: > $S/lms-calls.log
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Praxis head: $(git -C $P log -1 --format='%H, parents %P')"
bash $S/praxis-files-guarded.sh $P selection-mh local_model_selection local_model_demand_callers local_lane_policy
bash $S/praxis-files-guarded.sh $P related-mh $(tr '\n' ' ' < $E/praxis-round5-related-names.txt)
bash $S/praxis-files-guarded.sh $P more-related-mh $(tr '\n' ' ' < $E/praxis-round5-more-related-names.txt) lane_credit
cp $S/lms-calls.log $S/lms-calls-fixed-first-three-mh.log
echo "fake lms calls in its fixed log during the first three sets: $(wc -l < $S/lms-calls-fixed-first-three-mh.log | tr -d ' ') ($(tr '\n' ';' < $S/lms-calls-fixed-first-three-mh.log))"
echo "calls the run logs show failing at the fake lms (the console form, one line per call):"
grep -h '^\[LmAutoload\].*Command failed: .*fake-lms' $S/praxis-selection-mh-run.txt $S/praxis-related-mh-run.txt $S/praxis-more-related-mh-run.txt | sed 's/^/  /'
TAG=wider-mh bash $E/praxis-wider-run.sh
echo "Praxis head after: $(git -C $P log -1 --format=%H); working tree: $(git -C $P status --porcelain | wc -l | tr -d ' ') changed files"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
