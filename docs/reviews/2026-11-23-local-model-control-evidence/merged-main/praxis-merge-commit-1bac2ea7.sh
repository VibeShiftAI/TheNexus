#!/bin/bash
# Task fa032fc0, merge-conflict repair (attempt 1/2). The landing found that the
# Praxis run branch no longer merged cleanly into main 1bac2ea7. In the Praxis
# worktree, `git merge --no-ff --no-commit main` (21:26:56 EST, main 1bac2ea7,
# branch head 196a5375) stopped at two conflicts. Each was an addition on both
# sides at the same place, resolved by hand with every line of both sides kept:
#  - src/llm/local-lane-policy.ts, resetLocalLanePolicyForTests: main's four
#    reset lines (open operator grants, their listeners, episode admissions and
#    the graph hold reading) and the branch's runningJobs.clear();
#  - src/llm/manager.ts, the import list from ./local-lane-policy.js: main's
#    runHeldLocalLaneCall and the branch's trackLocalCall.
# This script checks the merged tree (the tree of the index once both files
# were staged, which the merge commit records) and re-runs the task's
# verification on it. It changes nothing in any repository and writes only in
# the scratch folder:
#  1. the tree against `git merge-tree --write-tree` of the same two commits:
#     only the two resolved files differ. For each, the conflict hunk as
#     `git merge-file --diff3` shows it, the resolution as a unified diff from
#     the file with markers, and the resolution compared with
#     `git merge-file --union` (main first), the resolution the round-7 merged
#     check tested at 20:36 EST (praxis-merged-1bac2ea7-196a5375.sh);
#  2. both sides kept: every path that only one side changed holds that side's
#     version, every other path the merge-base's; in each file both sides
#     changed, the lines the merged tree changes against the branch are the
#     lines main changed, and the lines it changes against main are the lines
#     the branch changed;
#  3. `npx tsc --noEmit` in the Praxis worktree, once its index and files match
#     the tree;
#  4. under every guard, the suites of the round-7 merged check on a scratch
#     copy of the tree, with NEXUS_TEST_ROOT at a scratch copy of TheNexus main
#     2a7952fc plus the TheNexus branch diff bd02642..6e14bc87; a failing suite
#     is rerun on a plain copy of main 1bac2ea7 against TheNexus 2a7952fc alone;
#  5. `npm run check:encoding` on every file the branch changed (the two
#     resolved files among them).
# Before running it, copy guards/ into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
P=$W/Praxis; N=$W/TheNexus
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
for f in praxis-files-guarded.sh lmstudio-guard.mjs net-guard.mjs live-port-guard.mjs fake-lms cli-shims/claude; do
  [ -e $S/$f ] || { echo "$S/$f is missing: copy guards/ into $S first"; exit 1; }
done
TREE=c8824b3e2d8e9dac62274cd1f549455a428c2b8b
PMAIN=$(git -C $P rev-parse 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d^{commit}) || exit 1
PBR=$(git -C $P rev-parse 196a537506d8b9076753ee1143cd527c3ac6eb14^{commit}) || exit 1
PBASE=$(git -C $P merge-base $PMAIN $PBR)
NEXUS_MAIN=$(git -C $N rev-parse 2a7952fcc63ea7b26d8148668c76800e73acc5c2^{commit}) || exit 1
git -C $P cat-file -e $TREE^{tree} || { echo "tree $TREE not found"; exit 1; }
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
touch $S/run-start-merge-commit.marker
GD=$(git -C $P rev-parse --git-dir)
echo "Praxis worktree: branch $(git -C $P branch --show-current), HEAD $(git -C $P rev-parse --short=8 HEAD)$([ -f $GD/MERGE_HEAD ] && echo ", merge in progress with $(cut -c1-8 $GD/MERGE_HEAD)"); main now $(git -C $P rev-parse --short=8 main)"
echo "HEAD's tree is the merged tree: $([ "$(git -C $P rev-parse HEAD^{tree})" = $TREE ] && echo yes || echo no); the index matches it: $(git -C $P diff --cached --quiet $TREE && echo yes || echo no); the working files match the index: $(git -C $P diff --quiet && echo yes || echo no); untracked files: $(git -C $P ls-files --others --exclude-standard | wc -l | tr -d ' ')"
echo "pinned: main ${PMAIN:0:8}, branch ${PBR:0:8}, their merge-base ${PBASE:0:8}, merged tree ${TREE:0:8}"
echo "TheNexus files changed after 6e14bc87 outside docs/reviews: $(git -C $N diff --name-only 6e14bc87 HEAD -- . ':(exclude)docs/reviews' | wc -l | tr -d ' ')"

T=$S/merge-commit-checks
fresh() { mkdir -p "$1" || exit 1; [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }
fresh $T

echo
echo "== 1. the merged tree against git merge-tree of main ${PMAIN:0:8} and the branch ${PBR:0:8}"
OUT=$(git -C $P merge-tree --write-tree $PMAIN $PBR 2>&1); RC=$?
MT=$(echo "$OUT" | head -1)
echo "merge-tree exit $RC (0 = merges without conflict, 1 = conflicts); its tree $MT (conflicted files written with markers)"
echo "$OUT" | grep -E '^CONFLICT'
echo "paths that differ between that tree and the merged tree: $(git -C $P diff --name-only $MT $TREE | tr '\n' ' ')"
for F in $(echo "$OUT" | awk -F'\t' '/^[0-7]+ [0-9a-f]+ [123]\t/{print $2}' | sort -u); do
  B=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 1$/{split($1,a," "); print a[2]}')
  M=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 2$/{split($1,a," "); print a[2]}')
  X=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 3$/{split($1,a," "); print a[2]}')
  git -C $P cat-file -p $B > $T/base; git -C $P cat-file -p $M > $T/main; git -C $P cat-file -p $X > $T/branch
  git -C $P cat-file -p "$TREE:$F" > $T/resolved
  cp $T/main $T/marked; git merge-file --diff3 -L main -L base -L branch $T/marked $T/base $T/branch
  echo "-- $F: $? conflict hunk(s), as git merge-file --diff3 shows them:"
  awk '/^<<<<<<< main/{p=1; print "   (line " NR ")"} p{print "   " $0} /^>>>>>>> branch/{p=0}' $T/marked
  echo "   against the marked file the merged tree's file drops $(diff $T/marked $T/resolved | grep -c '^<') line(s), $(diff $T/marked $T/resolved | grep '^<' | grep -cvE '^< (<<<<<<< main|\|\|\|\|\|\|\| base|=======|>>>>>>> branch)$') of them not a marker line, and adds $(diff $T/marked $T/resolved | grep -c '^>')"
  echo "   the resolution as a unified diff from the marked file (lines starting with - are dropped):"
  diff -u --label "$F with conflict markers" --label "$F in the merged tree" $T/marked $T/resolved | sed 's/^/   /'
  cp $T/main $T/union; git merge-file --union $T/union $T/base $T/branch
  echo "   byte-identical to git merge-file --union (main first), the resolution tested at 20:36 EST: $(cmp -s $T/union $T/resolved && echo yes || echo NO)"
  echo "   lines: merge-base $(wc -l < $T/base | tr -d ' '), main $(wc -l < $T/main | tr -d ' '), branch $(wc -l < $T/branch | tr -d ' '), merged $(wc -l < $T/resolved | tr -d ' ')"
done

echo
echo "== 2. both sides kept"
lst() { git -C $P ls-tree -r --full-tree "$1" | awk -F'\t' '{split($1,a," "); print $2 "\t" a[1] " " a[3]}'; }
lst $PBASE > $T/base.lst; lst $PMAIN > $T/main.lst; lst $PBR > $T/branch.lst; lst $TREE > $T/merged.lst
awk -F'\t' '
  FNR == 1 { n++ }
  { v[n, $1] = $2; p[$1] = 1 }
  END {
    for (f in p) {
      total++
      b = v[1, f]; m = v[2, f]; x = v[3, f]; r = v[4, f]
      if (m == b && x == b) { want = b; side = "merge-base" }
      else if (m == b) { want = x; side = "branch" }
      else if (x == b) { want = m; side = "main" }
      else if (m == x) { want = m; side = "same change on both sides" }
      else { both[++nb] = f; continue }
      count[side]++
      if (r != want) bad[++nbad] = f " (expected the " side " version)"
    }
    printf "paths in any of the four trees: %d; changed by main only: %d; by the branch only: %d; the same change on both: %d; by neither: %d\n", total, count["main"], count["branch"], count["same change on both sides"], count["merge-base"]
    printf "of those, paths whose merged entry (mode and blob, or absence) is not the expected one: %d\n", nbad
    for (i = 1; i <= nbad; i++) print "  " bad[i]
    printf "paths changed differently by both sides, merged line by line: %d\n", nb
    for (i = 1; i <= nb; i++) print both[i] > "'"$T/both-changed.txt"'"
  }' $T/base.lst $T/main.lst $T/branch.lst $T/merged.lst
changed_lines() { # <from> <to> <path>: the + and - lines of the diff, context and headers left out, sorted
  git -C $P diff --no-color --no-renames --no-ext-diff -U0 "$1" "$2" -- "$3" |
    awk '/^diff --git /{h=1; next} /^@@ /{h=0; next} h{next} /^[+-]/{print}' | LC_ALL=C sort
}
for F in $(LC_ALL=C sort $T/both-changed.txt 2>/dev/null); do
  changed_lines $PBASE $PMAIN "$F" > $T/a; changed_lines $PBR $TREE "$F" > $T/b
  changed_lines $PBASE $PBR "$F" > $T/c; changed_lines $PMAIN $TREE "$F" > $T/d
  echo "-- $F: main changed $(wc -l < $T/a | tr -d ' ') lines, the merged tree changes $(wc -l < $T/b | tr -d ' ') against the branch, the same lines: $(cmp -s $T/a $T/b && echo yes || echo NO); the branch changed $(wc -l < $T/c | tr -d ' ') lines, the merged tree changes $(wc -l < $T/d | tr -d ' ') against main, the same lines: $(cmp -s $T/c $T/d && echo yes || echo NO)"
  cmp -s $T/a $T/b || diff $T/a $T/b | sed 's/^/     main vs merged-against-branch: /'
  cmp -s $T/c $T/d || diff $T/c $T/d | sed 's/^/     branch vs merged-against-main: /'
done
echo "the merged tree against main: $(git -C $P diff --shortstat $PMAIN $TREE); the branch against the merge-base: $(git -C $P diff --shortstat $PBASE $PBR)"

echo
echo "== 3. npx tsc --noEmit in the Praxis worktree $P"
BEFORE=$(git -C $P status --porcelain | LC_ALL=C sort | shasum | cut -c1-16)
(cd $P && npx tsc --noEmit > $S/praxis-tsc-merge-commit.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merge-commit.txt)
echo "tsc: $(tail -1 $S/praxis-tsc-merge-commit.txt) ($(grep -c 'error TS' $S/praxis-tsc-merge-commit.txt) errors); git status the same before and after: $([ "$BEFORE" = "$(git -C $P status --porcelain | LC_ALL=C sort | shasum | cut -c1-16)" ] && echo yes || echo no)"

echo
echo "== 4. the suites, under every guard, on a scratch copy of the merged tree"
nexus_copy() { # dir with-branch(yes|no)
  fresh "$S/$1"
  git -C $N archive $NEXUS_MAIN | tar -x -C "$S/$1" || { echo "archive failed"; exit 1; }
  if [ "$2" = yes ]; then
    git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e 6e14bc87 > $S/nexus-branch-for-merge-commit.patch
    (cd "$S/$1" && git apply --whitespace=nowarn $S/nexus-branch-for-merge-commit.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
  fi
  ln -s $N/node_modules "$S/$1/node_modules"
  echo "$1: TheNexus ${NEXUS_MAIN:0:8}$([ "$2" = yes ] && echo " plus the branch diff bd02642..6e14bc87"), $(cd "$S/$1" && find . -type f ! -path './node_modules/*' | wc -l | tr -d ' ') files, nexus.db files: $(ls "$S/$1"/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
}
guarded_with_nexus() { # praxis-dir tag nexus-dir suites...
  local D=$1 TAG=$2 NX=$3; shift 3
  touch $S/$TAG.marker
  : > $S/lms-calls.log
  NEXUS_TEST_ROOT=$S/$NX bash $S/praxis-files-guarded.sh "$S/$D" $TAG "$@" | sed 1d
  echo "fake lms calls in its fixed log during the run: $(wc -l < $S/lms-calls.log | tr -d ' ') ($(sort $S/lms-calls.log | uniq -c | tr -s ' ' | tr '\n' ';'))"
  cp $S/lms-calls.log $S/lms-calls-fixed-$TAG.log
  echo "files written under $NX during the run (node_modules left out): $(find $S/$NX -newer $S/$TAG.marker -type f ! -path '*/node_modules/*' | wc -l | tr -d ' ')"
  find $S/$NX -newer $S/$TAG.marker -type f ! -path '*/node_modules/*' | sed "s#^$S/##"
  echo "nexus.db files there: $(ls $S/$NX/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
  rm -f $S/$TAG.marker
}
copy_tree() { # tree-ish dir
  local X=$1 D=$2 L=$T/files-$(basename "$2").txt
  fresh "$D"
  git -C $P archive $X | tar -x -C "$D" || { echo "archive failed"; exit 1; }
  git -C $P ls-tree -r $X | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "$(basename "$D") against ${X:0:8}: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3{print $2}' | tr '\n' ' '); extra files in the copy: $(cd "$D" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $L | sort) | wc -l | tr -d ' ')"
  ln -s $P/node_modules "$D/node_modules"
}
MP=$S/merge-commit-praxis
copy_tree $TREE $MP
SHARED_DATA=$(cd "$MP" && grep -lE "mkdtempSync\(['\"\`]/Volumes/" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "suites that make their data folder under /Volumes, left out: $(echo $SHARED_DATA | tr '\n' ' ')"
PREV=$(grep . $E/merged-main/praxis-suites179-1bac2ea7.txt)
ROUND7="local_model_selection local_model_demand_callers local_lane_policy quantized_tool_gate local_model_primary
  $(cat $E/praxis-round5-related-names.txt $E/praxis-round5-more-related-names.txt) lane_credit $(cat $E/praxis-wider-test-list.txt)"
ALL=""; MISSING=""; LEFT_OUT=""
for n in $PREV $ROUND7; do
  case " $ALL $LEFT_OUT $MISSING " in *" $n "*) continue;; esac
  if echo "$SHARED_DATA" | grep -qx "$n"; then LEFT_OUT="$LEFT_OUT $n"; continue; fi
  if [ -f "$MP/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo $ALL | tr ' ' '\n' > $S/praxis-suites-merge-commit.txt
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on the merged tree:${MISSING:- none}; selected but left out for their /Volumes data folder:${LEFT_OUT:- none}); the same list as the round-7 merged check (praxis-suites179-merged-196a5375.txt): $(cmp -s $S/praxis-suites-merge-commit.txt $E/merged-main/praxis-suites179-merged-196a5375.txt && echo yes || echo NO)"
nexus_copy nexus-for-merge-commit yes
guarded_with_nexus merge-commit-praxis merge-commit nexus-for-merge-commit $ALL
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merge-commit-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  copy_tree $PMAIN $S/plain-praxis-main-merge-commit
  nexus_copy nexus-for-plain-praxis-merge-commit no
  echo "== the same suites on plain main ${PMAIN:0:8}"
  guarded_with_nexus plain-praxis-main-merge-commit plain-merge-commit-failing nexus-for-plain-praxis-merge-commit $FAILING
fi

echo
echo "== 5. npm run check:encoding in the Praxis worktree, on every file the branch changed"
ENC=$(git -C $P diff --name-only $PBASE $PBR | while read -r f; do [ -f "$P/$f" ] && echo "$f"; done)
echo "files: $(echo $ENC | wc -w | tr -d ' ') (the two resolved files among them: $(echo "$ENC" | grep -cxE 'src/llm/(local-lane-policy|manager)\.ts'))"
(cd $P && npm run --silent check:encoding -- $ENC 2>&1; echo "exit $?")

echo
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start-merge-commit.marker | wc -l | tr -d ' ')"
echo "Praxis worktree after the run: HEAD $(git -C $P rev-parse --short=8 HEAD), the index matches the merged tree: $(git -C $P diff --cached --quiet $TREE && echo yes || echo no), the working files match the index: $(git -C $P diff --quiet && echo yes || echo no), untracked files: $(git -C $P ls-files --others --exclude-standard | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
