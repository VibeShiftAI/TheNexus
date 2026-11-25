#!/bin/bash
# Task fa032fc0, after review round 6: the Praxis branch head bd19e926 on Praxis
# main 1bac2ea7, still main when this was written (TheNexus main 2a7952fc,
# TheCortex main 17ee69ce). Round 6 changed src/llm/lmstudio-autoload.ts,
# src/llm/local-model-state.ts, src/voice/spoken-prose.ts and two test files,
# none of which main changed since the merge-base; the branch still conflicts
# with main in src/llm/local-lane-policy.ts and src/llm/manager.ts. This is
# praxis-merged-1bac2ea7-a8caeb09.sh with the new head, run outside every
# repository (no worktree, branch or clone), and needs nothing that script built:
#  1. git merge-tree --write-tree on main 1bac2ea7 and bd19e926, and each
#     conflict hunk from the three stage blobs (git merge-file --diff3);
#  2. a scratch copy of the merge-tree's tree with each conflicted file resolved
#     the way git merge-file --union does (every line from both sides kept,
#     main's first), shown as a unified diff from the file with markers to the
#     resolved file, and every file checked against the merge-tree's tree;
#  3. tsc on that copy;
#  4. under every guard, the 179 suites of the 1bac2ea7 check plus every suite of
#     the round-5 and round-6 runs on the branch head (the selection, related,
#     more-related and wider sets, the same lists in both rounds) that is not
#     among them, less every suite that makes its data folder under /Volumes.
#     NEXUS_TEST_ROOT points at a scratch copy of TheNexus main 2a7952fc plus the
#     TheNexus branch diff bd02642..6e14bc87 (TheNexus changed only its evidence
#     after 6e14bc87). A failing suite is rerun the same way on a plain copy of
#     main 1bac2ea7, against a scratch copy of TheNexus 2a7952fc alone.
# Before running it, copy guards/ into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
P=$W/Praxis; N=$W/TheNexus
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
for f in praxis-files-guarded.sh lmstudio-guard.mjs net-guard.mjs live-port-guard.mjs fake-lms cli-shims/claude; do
  [ -e $S/$f ] || { echo "$S/$f is missing: copy guards/ into $S first"; exit 1; }
done
PMAIN=$(git -C $P rev-parse 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d^{commit}) || exit 1
PBR=$(git -C $P rev-parse bd19e926a16509bd213f49c20f4c95bed95a43e9^{commit}) || exit 1
NEXUS_MAIN=$(git -C $N rev-parse 2a7952fcc63ea7b26d8148668c76800e73acc5c2^{commit}) || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
touch $S/run-start-praxis-bd.marker
echo "TheNexus files changed after 6e14bc87 outside docs/reviews: $(git -C $N diff --name-only 6e14bc87 HEAD -- . ':(exclude)docs/reviews' | wc -l | tr -d ' ')"
echo "Praxis files round 6 changed (a8caeb09..bd19e926): $(git -C $P diff --name-only a8caeb0943e83bfeac10671cc019f59a499c8277 $PBR | tr '\n' ' ')"

fresh() { mkdir -p "$1" || exit 1; [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }

# merged_copy as in merged-main-1bac2ea7-b06ed4dc.sh, plus the unified diff of each resolution.
merged_copy() { # <repo dir> <pinned main> <branch head> <main last checked> <copy dir>
  local R=$1 MAIN=$2 BR=$3 PREV=$4 D=$5 OUT TREE RC MB T L F B M X
  MB=$(git -C $R merge-base $MAIN $BR)
  echo "main now: $(git -C $R rev-parse --short=8 main); merge-base of the pinned main and the branch: ${MB:0:8}"
  echo "files main changed since $PREV: $(git -C $R diff --name-only $PREV $MAIN | wc -l | tr -d ' '); of them changed by the branch too: $(comm -12 <(git -C $R diff --name-only $PREV $MAIN | sort) <(git -C $R diff --name-only $MB $BR | sort) | tr '\n' ' ')"
  OUT=$(git -C $R merge-tree --write-tree $MAIN $BR 2>&1); RC=$?
  TREE=$(echo "$OUT" | head -1)
  echo "merge-tree exit $RC (0 = merges without conflict, 1 = conflicts); tree $TREE"
  echo "$OUT" | grep -E '^CONFLICT'
  fresh "$D"
  git -C $R archive $TREE | tar -x -C "$D" || { echo "archive failed"; exit 1; }
  T=$S/conflicts-$(basename "$D"); mkdir -p $T
  for F in $(echo "$OUT" | awk -F'\t' '/^[0-7]+ [0-9a-f]+ [123]\t/{print $2}' | sort -u); do
    B=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 1$/{split($1,a," "); print a[2]}')
    M=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 2$/{split($1,a," "); print a[2]}')
    X=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 3$/{split($1,a," "); print a[2]}')
    git -C $R cat-file -p $B > $T/base; git -C $R cat-file -p $M > $T/main; git -C $R cat-file -p $X > $T/branch
    cp $T/main $T/marked; git merge-file --diff3 -L main -L base -L branch $T/marked $T/base $T/branch
    echo "-- $F: $? conflict hunk(s), as git merge-file --diff3 shows them:"
    awk '/^<<<<<<< main/{p=1; print "   (line " NR ")"} p{print "   " $0} /^>>>>>>> branch/{p=0}' $T/marked
    cp $T/main "$D/$F"; git merge-file --union "$D/$F" $T/base $T/branch
    echo "   resolved with git merge-file --union. Against the marked file the resolution removes $(diff $T/marked "$D/$F" | grep -c '^<') line(s), $(diff $T/marked "$D/$F" | grep '^<' | grep -cvE '^< (<<<<<<< main|\|\|\|\|\|\|\| base|=======|>>>>>>> branch)$') of them not a marker line, and adds $(diff $T/marked "$D/$F" | grep -c '^>')"
    echo "   the resolution as a unified diff from the marked file (lines starting with - are dropped):"
    diff -u --label "$F with conflict markers" --label "$F resolved" $T/marked "$D/$F" | sed 's/^/   /'
  done
  L=$T/tree-files.txt
  git -C $R ls-tree -r $TREE | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "$(basename "$D") against the merge-tree's tree: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3{print $2}' | tr '\n' ' '); extra files in the copy: $(cd "$D" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $L | sort) | wc -l | tr -d ' ')"
}

nexus_copy() { # dir with-branch(yes|no)
  fresh "$S/$1"
  git -C $N archive $NEXUS_MAIN | tar -x -C "$S/$1" || { echo "archive failed"; exit 1; }
  if [ "$2" = yes ]; then
    git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e 6e14bc87 > $S/nexus-branch-for-praxis-bd.patch
    (cd "$S/$1" && git apply --whitespace=nowarn $S/nexus-branch-for-praxis-bd.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
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
  find $S/$NX -newer $S/$TAG.marker -type f ! -path '*/node_modules/*' | sed "s#^$S/##" | head -20
  echo "nexus.db files there: $(ls $S/$NX/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
  rm -f $S/$TAG.marker
}

echo "== Praxis: main pinned at $PMAIN, branch $PBR, base 1fcf4b59"
MP=$S/merged-praxis-bd
merged_copy $P $PMAIN $PBR 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d $MP
ln -s $P/node_modules "$MP/node_modules"
(cd "$MP" && npx tsc --noEmit > $S/praxis-tsc-merged-bd.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-bd.txt)
echo "tsc on the resolved merged tree: $(tail -1 $S/praxis-tsc-merged-bd.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-bd.txt) errors)"
SHARED_DATA=$(cd "$MP" && grep -lE "mkdtempSync\(['\"\`]/Volumes/" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "suites that make their data folder under /Volumes, left out: $(echo $SHARED_DATA | tr '\n' ' ')"
PREV=$(grep . $E/merged-main/praxis-suites179-1bac2ea7.txt)
ROUND6="local_model_selection local_model_demand_callers local_lane_policy quantized_tool_gate local_model_primary
  $(cat $E/praxis-round5-related-names.txt $E/praxis-round5-more-related-names.txt) lane_credit $(cat $E/praxis-wider-test-list.txt)"
ALL=""; MISSING=""; LEFT_OUT=""
for n in $PREV $ROUND6; do
  case " $ALL $LEFT_OUT $MISSING " in *" $n "*) continue;; esac
  if echo "$SHARED_DATA" | grep -qx "$n"; then LEFT_OUT="$LEFT_OUT $n"; continue; fi
  if [ -f "$MP/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on the merged tree:${MISSING:- none}; selected but left out for their /Volumes data folder:${LEFT_OUT:- none}); added to the 179: $(for n in $ALL; do grep -qx "$n" $E/merged-main/praxis-suites179-1bac2ea7.txt || printf '%s ' "$n"; done)"
echo $ALL | tr ' ' '\n' > $S/praxis-suites-merged-bd.txt
nexus_copy nexus-for-merged-praxis-bd yes
guarded_with_nexus merged-praxis-bd merged-bd nexus-for-merged-praxis-bd $ALL
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merged-bd-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the resolved merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  PP=$S/plain-praxis-main-bd
  fresh "$PP"
  git -C $P archive $PMAIN | tar -x -C "$PP" || { echo "archive failed"; exit 1; }
  ln -s $P/node_modules "$PP/node_modules"
  L=$S/tree-plain-praxis-bd.txt
  git -C $P ls-tree -r $PMAIN | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "plain-praxis-main-bd against $PMAIN: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$PP" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3' | wc -l | tr -d ' ')"
  nexus_copy nexus-for-plain-praxis-bd no
  echo "== the same suites on plain main $PMAIN"
  guarded_with_nexus plain-praxis-main-bd plain-bd-failing nexus-for-plain-praxis-bd $FAILING
fi
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start-praxis-bd.marker | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
