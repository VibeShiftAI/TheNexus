#!/bin/bash
# Round 7 end-of-task read-backs, read-only, one after another:
# criterion 1 precondition, dashboard tsc, criterion 9 read-back and attribution.
S=/Volumes/Projects/.scratch-fa032fc0
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
bash $E/criterion-1-precondition.sh > $S/criterion-1-precondition-r7.txt 2>&1; echo "precondition exit $?"
cp $N/dashboard/tsconfig.json $S/dashboard-tsconfig-before-r7.json
{
  echo "# npx tsc --noEmit in $N/dashboard"
  echo "# started $(date '+%Y-%m-%d %H:%M:%S %Z'), head $(git -C $N rev-parse --short=8 HEAD), working tree: $(git -C $N status --porcelain -- . ':(exclude)docs/reviews' | wc -l | tr -d ' ') changed files outside docs/reviews"
  (cd $N/dashboard && npx tsc --noEmit 2>&1; echo "exit $?")
  if cmp -s $N/dashboard/tsconfig.json $S/dashboard-tsconfig-before-r7.json; then echo "# dashboard/tsconfig.json unchanged by the run"; else echo "# dashboard/tsconfig.json CHANGED by the run"; fi
  echo "# finished $(date '+%H:%M:%S %Z')"
} > $S/dashboard-tsc-r7.txt 2>&1
cat $S/dashboard-tsc-r7.txt
bash $E/criterion-9-readback.sh > $S/criterion9-readback-r7.txt 2>&1; echo "readback exit $?"
bash $E/criterion-9-attribution.sh > $S/criterion-9-attribution-r7.txt 2>&1; echo "attribution exit $?"
