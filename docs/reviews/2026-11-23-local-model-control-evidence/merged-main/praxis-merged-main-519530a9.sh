#!/bin/bash
# Task fa032fc0: Praxis main moved twice after the merged check on fbce5c26:
# to e0dfe4ec at 15:01:16 (document delivery records and the document retire
# route) and to 519530a9 at 15:06:11 (the research tool's official sources).
# The only file both main and the branch change since fbce5c26 is
# src/nexus/client.ts. This repeats the merged check on 519530a9, pinned by its
# full hash, outside every repository (no worktree, branch or clone):
#  1. git merge-tree on the pinned main and the branch head;
#  2. merged-praxis8 = git archive of the pinned main plus the branch diff
#     against 1fcf4b59, checked file by file against the merge-tree's tree; tsc;
#  3. on the merged tree, under every guard (praxis-files-guarded.sh): the 96
#     suites of the fbce5c26 check, every suite main changed since 613f66b6, and
#     every suite that imports src/nexus/client.ts or a module main changed
#     since fbce5c26 (the research worker, its retrieval, PDF text and official
#     sources modules, the two discovery search clients, the step redaction);
#  4. any suite that fails in step 3, run the same way on a plain copy of the
#     pinned main, checked against that commit's tree.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
MAIN=$(git -C $P rev-parse 519530a961da9dc5d1ec50cd1c70152667051e5f^{commit}) || exit 1
HEAD_REV=$(git -C $P rev-parse cad6afb2^{commit}) || exit 1
echo "== Praxis: main pinned at $MAIN, branch $HEAD_REV, base 1fcf4b59"
echo "main now: $(git -C $P rev-parse --short=8 main)"
echo "merge-base: $(git -C $P merge-base $MAIN $HEAD_REV | cut -c1-8)"
OUT=$(git -C $P merge-tree --write-tree $MAIN $HEAD_REV 2>&1); RC=$?
TREE=$(echo "$OUT" | head -1)
echo "merge-tree exit $RC (0 = merges without conflict); tree $TREE"
[ $RC -eq 0 ] || { echo "$OUT" | head -20; exit 1; }
echo "files both sides change since the base: $(comm -12 <(git -C $P diff --name-only 1fcf4b59 $MAIN | sort) <(git -C $P diff --name-only 1fcf4b59 $HEAD_REV | sort) | tr '\n' ' ')"
echo "files main changed since fbce5c26: $(git -C $P diff --name-only fbce5c26 $MAIN | wc -l | tr -d ' '); shared with the branch: $(comm -12 <(git -C $P diff --name-only fbce5c26 $MAIN | sort) <(git -C $P diff --name-only 1fcf4b59 $HEAD_REV | sort) | tr '\n' ' ')"

identity() { # dir rev label
  local D=$1 REV=$2 T
  T=$(mktemp)
  git -C $P ls-tree -r "$REV" -- src tests scripts package.json | awk -F'\t' '{split($1,a," "); print a[3]"\t"$2}' > "$T"
  echo "$3: $(wc -l < "$T" | tr -d ' ') tracked files compared, $(paste <(cut -f1 "$T") <(cut -f2 "$T" | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk '$1!=$2' | wc -l | tr -d ' ') differ, $(cd "$D" && find src tests scripts -type f | sort | comm -23 - <(cut -f2 "$T" | sort) | wc -l | tr -d ' ') extra files in the copy"
  rm -f "$T"
}
build() { # dir
  mkdir -p "$S/$1" || exit 1
  [ -z "$(ls -A "$S/$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }
  git -C $P archive $MAIN | tar -x -C "$S/$1" || { echo "archive failed"; exit 1; }
  ln -s $P/node_modules "$S/$1/node_modules"
}

build merged-praxis8
git -C $P diff --binary 1fcf4b59 $HEAD_REV > $S/praxis-branch8.patch
(cd "$S/merged-praxis8" && git apply --whitespace=nowarn $S/praxis-branch8.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch8.patch) files"
identity "$S/merged-praxis8" "$TREE" "merged-praxis8 against the merge-tree's tree"
(cd "$S/merged-praxis8" && npx tsc --noEmit > $S/praxis-tsc-merged-main8.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main8.txt)
echo "tsc on the merged tree: $(tail -1 $S/praxis-tsc-merged-main8.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-main8.txt) errors)"

RELATED=$(sed -n 's/^Running 40 of [0-9]* suite(s): //p' $S/praxis-related-r4-run.txt | tr ' ' '\n' | sed 's#tests/##; s#\.test\.ts$##' | grep .)
NINE="cli_concurrency cli_dispatch_gate_wakeup cli_run_footprint dispatch_routing_preparation eval_judge_comparability executor_routing_preparation run_worktree_dispatch system_map_dispatch_yield task_saved_model_dispatch"
WIDER=$(grep -vx maintenance_review_regressions $S/praxis-manager-importers.txt)
NEWMAIN=$(git -C $P diff --name-only --diff-filter=A 4d076f91 $MAIN -- tests | sed -n 's#^tests/\(.*\)\.test\.ts$#\1#p')
MOVED=$(git -C $P diff --name-only 613f66b6 $MAIN -- tests | sed -n 's#^tests/\(.*\)\.test\.ts$#\1#p')
COUPLED=$(cd "$S/merged-praxis8" && grep -lE "nexus/client(\.js)?['\"]|deep-research-worker|step-redaction|research/(official-sources|web-access|web-retrieval|pdf-text)|ingestion/discovery/(brave-search|search-client)" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "suites importing src/nexus/client.ts or a module main changed since fbce5c26: $(echo $COUPLED | wc -w | tr -d ' ')"
ALL=""; MISSING=""
for n in $RELATED quantized_tool_gate $NINE $WIDER $NEWMAIN $MOVED $COUPLED; do
  case " $ALL " in *" $n "*) continue;; esac
  if [ -f "$S/merged-praxis8/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on main:$MISSING)"
bash $S/praxis-files-guarded.sh "$S/merged-praxis8" merged8 $ALL | sed 1d
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merged8-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  build plain-praxis-main8
  identity "$S/plain-praxis-main8" "$MAIN" "plain-praxis-main8 against $MAIN"
  echo "== the same suites on plain main $MAIN"
  bash $S/praxis-files-guarded.sh "$S/plain-praxis-main8" plain8-failing $FAILING | sed 1d
fi
echo "== done"
