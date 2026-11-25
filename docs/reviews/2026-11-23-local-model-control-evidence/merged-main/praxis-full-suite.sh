#!/bin/bash
# Task fa032fc0: the whole Praxis suite on the tree merged with main (merged-praxis5),
# under every guard of praxis-files-guarded.sh. Left out: the six maintenance_*
# suites that make their data dir under /Volumes/Projects/maintenance-mode-worktrees
# (a shared folder) instead of a temp dir; none imports a module this task changed
# except maintenance_review_regressions, which replaces llmManager.complete.
S=/Volumes/Projects/.scratch-fa032fc0
DIR=${1:-$S/merged-praxis5}; TAG=${2:-merged5-full}
SKIP="maintenance_intake maintenance_policy maintenance_review_regressions maintenance_batches maintenance_reports maintenance_policy_router"
NAMES=$(cd $DIR && ls tests/*.test.ts | sed "s#tests/##; s#\.test\.ts\$##" | grep -vxF -f <(echo $SKIP | tr " " "\n") | tr "\n" " ")
echo "suites: $(echo $NAMES | wc -w | tr -d ' ') of $(ls $DIR/tests/*.test.ts | wc -l | tr -d ' ')"
START=$(date +%s)
bash $S/praxis-files-guarded.sh $DIR $TAG $NAMES | sed 1d
echo "took $(( $(date +%s) - START ))s"
