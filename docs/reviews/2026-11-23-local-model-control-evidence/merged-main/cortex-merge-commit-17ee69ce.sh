#!/bin/bash
# Task fa032fc0, merge-conflict repair (attempt 1/2). The landing previews every
# repository of the task and stops at the first that does not merge
# (Praxis src/orchestrator/run-landing.ts), so after Praxis it would have
# stopped at TheCortex, whose run branch conflicts with main 17ee69ce in
# TheCortex/conftest.py. In the TheCortex worktree,
# `git merge --no-ff --no-commit main` (21:37:02 EST, main 17ee69ce, branch head
# 892708c8) stopped at that one conflict. Both sides added `import pytest` at
# the same place: git's merge took that line out of the conflict, leaving this
# branch's autouse fixture local_model_setting_offline (with its helper)
# against nothing from main. Resolved by hand by keeping the branch's block;
# main's own addition, the autouse fixture graph_episode_hold_per_test and its
# docstring paragraph, merged without conflict below it.
# This script checks the merged tree (the tree of the index once the file was
# staged, which the merge commit records) and re-runs the TheCortex checks on
# it. It changes nothing in any repository and writes only in the scratch
# folder:
#  1. the tree against `git merge-tree --write-tree` of the same two commits:
#     only conftest.py differs. The conflict hunk as `git merge-file --diff3`
#     shows it, the resolution as a unified diff from the file with markers, and
#     the resolution compared with `git merge-file --union` (main first), the
#     resolution the merged check tested at 18:46 EST
#     (cortex-merged-17ee69ce-892708c8.sh);
#  2. both sides kept: every path that only one side changed holds that side's
#     version, every other path the merge-base's; in each file both sides
#     changed, the lines the merged tree changes against the branch are the
#     lines main changed, and the lines it changes against main are the lines
#     the branch changed, less any line main had added already;
#  3. the 12 test files of the merged checks through cortex-tests.sh (every
#     service URL on port 1, the offline network plugin, the conftest's store
#     guard) on a scratch copy of the tree, and test_local_model_setting.py
#     verbose; a failing file is rerun on a plain copy of main 17ee69ce;
#  4. Praxis's `npm run check:encoding` on every file the branch changed.
# Before running it, copy guards/ into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
C=$W/TheCortex; P=$W/Praxis
[ -e $S/cortex-tests.sh ] || { echo "$S/cortex-tests.sh is missing: copy guards/ into $S first"; exit 1; }
TREE=588b1ca4b4cce9dbca72277ed8af1a11bcf23f6a
CMAIN=$(git -C $C rev-parse 17ee69cebb5c1403dbef27929d19963134e8bec8^{commit}) || exit 1
CBR=$(git -C $C rev-parse 892708c8df06133e9b545962ac82575ec7eea9c0^{commit}) || exit 1
CBASE=$(git -C $C merge-base $CMAIN $CBR)
git -C $C cat-file -e $TREE^{tree} || { echo "tree $TREE not found"; exit 1; }
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
touch $S/run-start-cortex-merge-commit.marker
GD=$(git -C $C rev-parse --git-dir)
echo "TheCortex worktree: branch $(git -C $C branch --show-current), HEAD $(git -C $C rev-parse --short=8 HEAD)$([ -f $GD/MERGE_HEAD ] && echo ", merge in progress with $(cut -c1-8 $GD/MERGE_HEAD)"); main now $(git -C $C rev-parse --short=8 main)"
echo "HEAD's tree is the merged tree: $([ "$(git -C $C rev-parse HEAD^{tree})" = $TREE ] && echo yes || echo no); the index matches it: $(git -C $C diff --cached --quiet $TREE && echo yes || echo no); the working files match the index: $(git -C $C diff --quiet && echo yes || echo no); untracked files: $(git -C $C ls-files --others --exclude-standard | wc -l | tr -d ' ')"
echo "pinned: main ${CMAIN:0:8}, branch ${CBR:0:8}, their merge-base ${CBASE:0:8}, merged tree ${TREE:0:8}"

T=$S/cortex-merge-commit-checks
fresh() { mkdir -p "$1" || exit 1; [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }
fresh $T

echo
echo "== 1. the merged tree against git merge-tree of main ${CMAIN:0:8} and the branch ${CBR:0:8}"
OUT=$(git -C $C merge-tree --write-tree $CMAIN $CBR 2>&1); RC=$?
MT=$(echo "$OUT" | head -1)
echo "merge-tree exit $RC (0 = merges without conflict, 1 = conflicts); its tree $MT (conflicted files written with markers)"
echo "$OUT" | grep -E '^CONFLICT'
echo "paths that differ between that tree and the merged tree: $(git -C $C diff --name-only $MT $TREE | tr '\n' ' ')"
for F in $(echo "$OUT" | awk -F'\t' '/^[0-7]+ [0-9a-f]+ [123]\t/{print $2}' | sort -u); do
  B=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 1$/{split($1,a," "); print a[2]}')
  M=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 2$/{split($1,a," "); print a[2]}')
  X=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 3$/{split($1,a," "); print a[2]}')
  git -C $C cat-file -p $B > $T/base; git -C $C cat-file -p $M > $T/main; git -C $C cat-file -p $X > $T/branch
  git -C $C cat-file -p "$TREE:$F" > $T/resolved
  cp $T/main $T/marked; git merge-file --diff3 -L main -L base -L branch $T/marked $T/base $T/branch
  echo "-- $F: $? conflict hunk(s), as git merge-file --diff3 shows them:"
  awk '/^<<<<<<< main/{p=1; print "   (line " NR ")"} p{print "   " $0} /^>>>>>>> branch/{p=0}' $T/marked
  echo "   against the marked file the merged tree's file drops $(diff $T/marked $T/resolved | grep -c '^<') line(s), $(diff $T/marked $T/resolved | grep '^<' | grep -cvE '^< (<<<<<<< main|\|\|\|\|\|\|\| base|=======|>>>>>>> branch)$') of them not a marker line, and adds $(diff $T/marked $T/resolved | grep -c '^>')"
  echo "   the resolution as a unified diff from the marked file (lines starting with - are dropped):"
  diff -u --label "$F with conflict markers" --label "$F in the merged tree" $T/marked $T/resolved | sed 's/^/   /'
  cp $T/main $T/union; git merge-file --union $T/union $T/base $T/branch
  echo "   byte-identical to git merge-file --union (main first), the resolution tested at 18:46 EST: $(cmp -s $T/union $T/resolved && echo yes || echo NO)"
  echo "   lines: merge-base $(wc -l < $T/base | tr -d ' '), main $(wc -l < $T/main | tr -d ' '), branch $(wc -l < $T/branch | tr -d ' '), merged $(wc -l < $T/resolved | tr -d ' '); lines reading 'import pytest': $(grep -cx 'import pytest' $T/resolved)"
done

echo
echo "== 2. both sides kept"
lst() { git -C $C ls-tree -r --full-tree "$1" | awk -F'\t' '{split($1,a," "); print $2 "\t" a[1] " " a[3]}'; }
lst $CBASE > $T/base.lst; lst $CMAIN > $T/main.lst; lst $CBR > $T/branch.lst; lst $TREE > $T/merged.lst
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
  git -C $C diff --no-color --no-renames --no-ext-diff -U0 "$1" "$2" -- "$3" |
    awk '/^diff --git /{h=1; next} /^@@ /{h=0; next} h{next} /^[+-]/{print}' | LC_ALL=C sort
}
for F in $(LC_ALL=C sort $T/both-changed.txt 2>/dev/null); do
  changed_lines $CBASE $CMAIN "$F" > $T/a; changed_lines $CBR $TREE "$F" > $T/b
  changed_lines $CBASE $CBR "$F" > $T/c; changed_lines $CMAIN $TREE "$F" > $T/d
  echo "-- $F: main changed $(wc -l < $T/a | tr -d ' ') lines, the merged tree changes $(wc -l < $T/b | tr -d ' ') against the branch, the same lines: $(cmp -s $T/a $T/b && echo yes || echo NO); the branch changed $(wc -l < $T/c | tr -d ' ') lines, the merged tree changes $(wc -l < $T/d | tr -d ' ') against main, the same lines: $(cmp -s $T/c $T/d && echo yes || echo NO)"
  cmp -s $T/a $T/b || diff $T/a $T/b | sed 's/^/     main vs merged-against-branch: /'
  cmp -s $T/c $T/d || diff $T/c $T/d | sed 's/^/     branch vs merged-against-main: /'
done
echo "the merged tree against main: $(git -C $C diff --shortstat $CMAIN $TREE); the branch against the merge-base: $(git -C $C diff --shortstat $CBASE $CBR)"

echo
echo "== 3. the TheCortex tests on a scratch copy of the merged tree"
copy_tree() { # tree-ish dir
  local X=$1 D=$2 L=$T/files-$(basename "$2").txt
  fresh "$D"
  git -C $C archive $X | tar -x -C "$D" || { echo "archive failed"; exit 1; }
  git -C $C ls-tree -r $X | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "$(basename "$D") against ${X:0:8}: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3{print $2}' | tr '\n' ' '); extra files in the copy: $(cd "$D" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $L | sort) | wc -l | tr -d ' ')"
  # As in the earlier merged checks: the worktree's own (ignored) .env, linked, not read here.
  [ -e $C/TheCortex/.env ] && ln -s $C/TheCortex/.env "$D/TheCortex/.env"
}
MC=$S/cortex-merge-commit
copy_tree $TREE $MC
CT="tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py \
  tests/test_praxis_local_llm_route.py tests/test_client_embedder.py python/test_acted_on_retrieval.py python/test_packet_format.py \
  python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py tests/test_graph_episode_hold.py"
for f in $CT; do [ -f "$MC/TheCortex/$f" ] || echo "MISSING on the merged tree: $f"; done
touch $S/cortex-merge-commit-tests.marker
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merge-commit-tests.txt $CT
echo "the 12 files (quiet, so pytest prints no header):"
grep -E "(passed|failed|error)|^exit=" $S/cortex-merge-commit-tests.txt | tail -2
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merge-commit-local-model-verbose.txt -vv tests/test_local_model_setting.py
echo "test_local_model_setting.py, verbose: $(grep -E '^=+ .*(passed|failed).* =+$|^exit=' $S/cortex-merge-commit-local-model-verbose.txt | tr '\n' ' ')"
echo "its header line from the store guard: $(grep -m1 '^cortex_test_guard' $S/cortex-merge-commit-local-model-verbose.txt)"
CFAIL=$(grep -hoE "^(FAILED|ERROR) [^: ]+\.py" $S/cortex-merge-commit-tests.txt $S/cortex-merge-commit-local-model-verbose.txt | awk '{print $2}' | sort -u)
echo "TheCortex files with failures on the merged tree: $(echo $CFAIL | tr '\n' ' ')"
if [ -n "$CFAIL" ]; then
  PC=$S/plain-cortex-main-merge-commit
  copy_tree $CMAIN $PC
  echo "== the same files on plain main ${CMAIN:0:8}"
  bash $S/cortex-tests.sh "$PC/TheCortex" $S/cortex-plain-merge-commit-tests.txt $(echo $CFAIL | sed 's#TheCortex/##g')
  grep -E "(passed|failed|error)|^exit=" $S/cortex-plain-merge-commit-tests.txt | tail -2
fi
echo "files written in the merged copy since its test runs started: $(find "$MC" -newer $S/cortex-merge-commit-tests.marker -type f | wc -l | tr -d ' ')"

echo
echo "== 4. npm run check:encoding (Praxis's scanner) on every file the TheCortex branch changed"
ENC=$(git -C $C diff --name-only $CBASE $CBR | while read -r f; do [ -f "$C/$f" ] && echo "$C/$f"; done)
echo "files: $(echo $ENC | wc -w | tr -d ' ') (conftest.py among them: $(echo "$ENC" | grep -c '/TheCortex/conftest\.py$'))"
(cd $P && npm run --silent check:encoding -- $ENC 2>&1; echo "exit $?")

echo
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start-cortex-merge-commit.marker | wc -l | tr -d ' ')"
echo "TheCortex worktree after the run: HEAD $(git -C $C rev-parse --short=8 HEAD), the index matches the merged tree: $(git -C $C diff --cached --quiet $TREE && echo yes || echo no), the working files match the index: $(git -C $C diff --quiet && echo yes || echo no), untracked files: $(git -C $C ls-files --others --exclude-standard | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
