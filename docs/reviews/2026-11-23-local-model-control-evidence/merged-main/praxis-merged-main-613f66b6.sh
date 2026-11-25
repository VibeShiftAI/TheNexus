#!/bin/bash
# Task fa032fc0: Praxis main moved to 613f66b6 (proof baseline lifecycle) at
# 14:25:54, after the full-suite check on 4d076f91. This repeats the merged check
# on the new main, outside every repository (no worktree, branch or clone):
#  1. git merge-tree on the real branches, and the files both sides change;
#  2. merged-praxis6 = git archive main plus the branch diff against 1fcf4b59; tsc;
#  3. plain-praxis-main6 = git archive main, unchanged;
#  4. on the merged tree, under every guard (praxis-files-guarded.sh): the 40
#     related suites of the round-4 run that exist on main, quantized_tool_gate,
#     the nine suites that name the changed symbols, the 40 wider suites, and the
#     five suites main's new commits add;
#  5. any suite that fails in step 4, run the same way on plain main.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
MAIN=$(git -C $P rev-parse --short main)
echo "== Praxis: main $MAIN, branch $(git -C $P rev-parse --short HEAD), base 1fcf4b59"
echo "merge-base: $(git -C $P merge-base main HEAD | cut -c1-8)"
OUT=$(git -C $P merge-tree --write-tree main HEAD 2>&1); RC=$?
echo "merge-tree exit $RC (0 = merges without conflict); tree $(echo "$OUT" | head -1 | cut -c1-12)"
[ $RC -eq 0 ] || { echo "$OUT" | head -20; exit 1; }
echo "files both sides change since the base: $(comm -12 <(git -C $P diff --name-only 1fcf4b59 main | sort) <(git -C $P diff --name-only 1fcf4b59 HEAD | sort) | tr '\n' ' ')"
for d in merged-praxis6 plain-praxis-main6; do
  mkdir -p "$S/$d" || exit 1
  [ -z "$(ls -A "$S/$d")" ] || { echo "$d is not empty, stopping"; exit 1; }
  git -C $P archive main | tar -x -C "$S/$d" || { echo "archive failed"; exit 1; }
  ln -s $P/node_modules "$S/$d/node_modules"
done
git -C $P diff --binary 1fcf4b59 HEAD > $S/praxis-branch6.patch
(cd "$S/merged-praxis6" && git apply --whitespace=nowarn $S/praxis-branch6.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch6.patch) files"
(cd "$S/merged-praxis6" && npx tsc --noEmit > $S/praxis-tsc-merged-main6.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main6.txt)
echo "tsc on the merged tree: $(tail -1 $S/praxis-tsc-merged-main6.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-main6.txt) errors)"
RELATED=$(sed -n 's/^Running 40 of [0-9]* suite(s): //p' $S/praxis-related-r4-run.txt | tr ' ' '\n' | sed 's#tests/##; s#\.test\.ts$##' | grep .)
NINE="cli_concurrency cli_dispatch_gate_wakeup cli_run_footprint dispatch_routing_preparation eval_judge_comparability executor_routing_preparation run_worktree_dispatch system_map_dispatch_yield task_saved_model_dispatch"
WIDER=$(grep -vx maintenance_review_regressions $S/praxis-manager-importers.txt)
NEWMAIN=$(git -C $P diff --name-only --diff-filter=A 4d076f91 main -- tests | sed -n 's#^tests/\(.*\)\.test\.ts$#\1#p')
ALL=""; MISSING=""
for n in $RELATED quantized_tool_gate $NINE $WIDER $NEWMAIN; do
  case " $ALL " in *" $n "*) continue;; esac
  if [ -f "$S/merged-praxis6/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on main:$MISSING); new on main: $(echo $NEWMAIN | tr '\n' ' ')"
bash $S/praxis-files-guarded.sh "$S/merged-praxis6" merged6 $ALL | sed 1d
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merged6-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  echo "== the same suites on plain main $MAIN"
  bash $S/praxis-files-guarded.sh "$S/plain-praxis-main6" plain6-failing $FAILING | sed 1d
fi
echo "== done"
