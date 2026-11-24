#!/bin/bash
# Task fa032fc0, after the round-4 commit: the Praxis branch on a tree that merges
# it with Praxis main. Built from `git archive main` plus the branch diff against
# the task baseline 1fcf4b59, outside every repository (no worktree, branch or
# clone). Also reports what git merge-tree says about the real merge.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
MP=$S/merged-praxis5
echo "== Praxis: main $(git -C $P rev-parse --short main), branch $(git -C $P rev-parse --short HEAD), base 1fcf4b59"
echo "merge-base: $(git -C $P merge-base main HEAD | cut -c1-8)"
OUT=$(git -C $P merge-tree --write-tree main HEAD 2>&1); RC=$?
echo "merge-tree exit $RC (0 = merges without conflict); tree $(echo "$OUT" | head -1 | cut -c1-12)"
[ $RC -eq 0 ] || echo "$OUT" | head -20
mkdir -p "$MP" || exit 1
[ -z "$(ls -A "$MP")" ] || { echo "merged-praxis5 is not empty, stopping"; exit 1; }
git -C $P archive main | tar -x -C "$MP" || { echo "archive failed"; exit 1; }
git -C $P diff --binary 1fcf4b59 HEAD > $S/praxis-branch5.patch
(cd "$MP" && git apply --whitespace=nowarn $S/praxis-branch5.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch5.patch) files"
ln -s $P/node_modules "$MP/node_modules"
(cd "$MP" && npx tsc --noEmit > $S/praxis-tsc-merged-main5.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main5.txt)
echo "tsc on the merged tree: $(tail -1 $S/praxis-tsc-merged-main5.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-main5.txt) errors)"
echo "== done"
