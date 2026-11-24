#!/bin/bash
# Task fa032fc0: Praxis main moved again after the merged check on 519530a9, to
# 59cacac6 at 15:51:18 (task ec3e1d0c: keep review documents approvable after
# the run that wrote them lands). Since 519530a9 main changed five source
# modules (src/executors/run-worktree.ts, src/nexus/client.ts and
# src/orchestrator/run-documents.ts, run-landing.ts and run-merge.ts), two
# tests, one script, one doc and 188 data records. The one file both main and
# the branch change since 519530a9 is src/nexus/client.ts. This repeats the
# merged check on 59cacac6, pinned by its full hash, outside every repository
# (no worktree, branch or clone):
#  1. git merge-tree on the pinned main and the branch head;
#  2. merged-praxis9 = git archive of the pinned main plus the branch diff
#     against 1fcf4b59, checked file by file against the merge-tree's tree; tsc;
#  3. on the merged tree, under every guard (praxis-files-guarded.sh): the 144
#     suites of the 519530a9 check (praxis-suites144-519530a9.txt), the suites
#     main changed since 519530a9, and every suite that imports one of the five
#     modules main changed since 519530a9;
#  4. any suite that fails in step 3, run the same way on a plain copy of the
#     pinned main, checked against that commit's tree.
# Suites that load TheNexus code do it through tests/fixtures/nexus-require.ts:
# NEXUS_TEST_ROOT, else a sibling ../TheNexus, else the shared checkout
# /Volumes/Projects/TheNexus. One suite new to this check, run_merge_documents,
# loads TheNexus's db module and documents router that way. So each run here
# sets NEXUS_TEST_ROOT to a scratch TheNexus copy with no nexus.db: for the
# merged tree, TheNexus main 2a7952fc plus the TheNexus branch diff (what lands
# together); for plain main, TheNexus main 2a7952fc alone. The script lists
# every file the run wrote in that copy.
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
NEXUS_MAIN=$(git -C $N rev-parse 2a7952fcc63ea7b26d8148668c76800e73acc5c2^{commit}) || exit 1
nexus_copy() { # dir with-branch(yes|no)
  mkdir -p "$S/$1" || exit 1
  [ -z "$(ls -A "$S/$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }
  git -C $N archive $NEXUS_MAIN | tar -x -C "$S/$1" || { echo "archive failed"; exit 1; }
  if [ "$2" = yes ]; then
    git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e 6e14bc87 > $S/nexus-branch-for-praxis9.patch
    (cd "$S/$1" && git apply --whitespace=nowarn $S/nexus-branch-for-praxis9.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
  fi
  ln -s $N/node_modules "$S/$1/node_modules"
  echo "$1: TheNexus ${NEXUS_MAIN:0:8}$([ "$2" = yes ] && echo " plus the branch diff bd02642..6e14bc87"), $(cd "$S/$1" && find . -type f ! -path './node_modules/*' | wc -l | tr -d ' ') files, nexus.db files: $(ls "$S/$1"/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
}
guarded_with_nexus() { # praxis-dir tag nexus-dir suites...
  local D=$1 TAG=$2 NX=$3; shift 3
  touch $S/$TAG.marker
  NEXUS_TEST_ROOT=$S/$NX bash $S/praxis-files-guarded.sh "$S/$D" $TAG "$@" | sed 1d
  echo "files written under $NX during the run (node_modules left out): $(find $S/$NX -newer $S/$TAG.marker -type f ! -path '*/node_modules/*' | wc -l | tr -d ' ')"
  find $S/$NX -newer $S/$TAG.marker -type f ! -path '*/node_modules/*' | sed "s#^$S/##" | head -20
  echo "nexus.db files there: $(ls $S/$NX/nexus.db* 2>/dev/null | wc -l | tr -d ' ')"
  rm -f $S/$TAG.marker
}
MAIN=$(git -C $P rev-parse 59cacac68a6deb58cbda55f49836ba2e975c0f4e^{commit}) || exit 1
HEAD_REV=$(git -C $P rev-parse cad6afb2^{commit}) || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== Praxis: main pinned at $MAIN, branch $HEAD_REV, base 1fcf4b59"
echo "main now: $(git -C $P rev-parse --short=8 main)"
echo "merge-base: $(git -C $P merge-base $MAIN $HEAD_REV | cut -c1-8)"
OUT=$(git -C $P merge-tree --write-tree $MAIN $HEAD_REV 2>&1); RC=$?
TREE=$(echo "$OUT" | head -1)
echo "merge-tree exit $RC (0 = merges without conflict); tree $TREE"
[ $RC -eq 0 ] || { echo "$OUT" | head -20; exit 1; }
echo "files both sides change since the base: $(comm -12 <(git -C $P diff --name-only 1fcf4b59 $MAIN | sort) <(git -C $P diff --name-only 1fcf4b59 $HEAD_REV | sort) | tr '\n' ' ')"
echo "files main changed since 519530a9: $(git -C $P diff --name-only 519530a9 $MAIN | wc -l | tr -d ' '); shared with the branch: $(comm -12 <(git -C $P diff --name-only 519530a9 $MAIN | sort) <(git -C $P diff --name-only 1fcf4b59 $HEAD_REV | sort) | tr '\n' ' ')"
echo "source files main changed since 519530a9: $(git -C $P diff --name-only 519530a9 $MAIN -- src | tr '\n' ' ')"

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

build merged-praxis9
git -C $P diff --binary 1fcf4b59 $HEAD_REV > $S/praxis-branch9.patch
(cd "$S/merged-praxis9" && git apply --whitespace=nowarn $S/praxis-branch9.patch) || { echo "PRAXIS APPLY FAILED"; exit 1; }
echo "patch applied: $(grep -c '^diff --git' $S/praxis-branch9.patch) files"
identity "$S/merged-praxis9" "$TREE" "merged-praxis9 against the merge-tree's tree"
(cd "$S/merged-praxis9" && npx tsc --noEmit > $S/praxis-tsc-merged-main9.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged-main9.txt)
echo "tsc on the merged tree: $(tail -1 $S/praxis-tsc-merged-main9.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged-main9.txt) errors)"

PREV=$(grep . $E/merged-main/praxis-suites144-519530a9.txt)
CHANGED=$(git -C $P diff --name-only 519530a9 $MAIN -- tests | sed -n 's#^tests/\(.*\)\.test\.ts$#\1#p')
COUPLED=$(cd "$S/merged-praxis9" && grep -lE "(executors/run-worktree|nexus/client|orchestrator/run-documents|orchestrator/run-landing|orchestrator/run-merge)(\.js)?['\"]" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "suites main changed since 519530a9: $(echo $CHANGED | tr '\n' ' ')"
echo "suites importing a module main changed since 519530a9: $(echo $COUPLED | wc -w | tr -d ' ')"
ALL=""; MISSING=""
for n in $PREV $CHANGED $COUPLED; do
  case " $ALL " in *" $n "*) continue;; esac
  if [ -f "$S/merged-praxis9/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on the merged tree:${MISSING:- none}); added to the 144: $(for n in $ALL; do grep -qx "$n" $E/merged-main/praxis-suites144-519530a9.txt || printf '%s ' "$n"; done)"
echo $ALL | tr ' ' '\n' > $S/praxis-suites-59cacac6.txt
nexus_copy nexus-for-merged-praxis9 yes
guarded_with_nexus merged-praxis9 merged9 nexus-for-merged-praxis9 $ALL
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merged9-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  build plain-praxis-main9
  identity "$S/plain-praxis-main9" "$MAIN" "plain-praxis-main9 against $MAIN"
  nexus_copy nexus-for-plain-praxis9 no
  echo "== the same suites on plain main $MAIN"
  guarded_with_nexus plain-praxis-main9 plain9-failing nexus-for-plain-praxis9 $FAILING
fi
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
