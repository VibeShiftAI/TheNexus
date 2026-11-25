#!/bin/bash
# Task fa032fc0: at 16:22 EST, after the merged checks on TheNexus 2a7952fc and
# Praxis 59cacac6, task 98d0b1b9 (hold daytime knowledge-graph extraction for
# the overnight window so Gemma stays unloaded by day) landed on Praxis main
# (1bac2ea7, 16:22:26) and TheCortex main (b06ed4dc, 16:22:23). TheNexus main
# stayed at 2a7952fc. Both branches now conflict with main: Praxis in
# src/llm/local-lane-policy.ts and src/llm/manager.ts, TheCortex in
# conftest.py. This run may not merge main into its branches; Praxis's landing
# sends a conflicted task back to its executor to merge main and resolve the
# conflicts by hand (src/orchestrator/run-merge.ts, conflictCorrection). So
# this script works outside every repository (no worktree, branch or clone).
# For each of the two repositories:
#  1. git merge-tree --write-tree on the pinned main and the branch head, and
#     each conflict hunk from the three stage blobs (git merge-file --diff3);
#  2. a scratch copy of the merge-tree's tree, with each conflicted file
#     resolved the way git merge-file --union does (every line from both sides
#     kept, main's first). It counts what the resolution removed against the
#     marked file (only marker lines) and checks every file against the
#     merge-tree's tree (only the resolved files differ);
#  3. Praxis: tsc, then under every guard the 152 suites of the 59cacac6 check,
#     the suites main changed since 59cacac6 and every suite that imports a
#     source module main changed since 59cacac6, less every suite that makes
#     its data folder under /Volumes (fs.mkdtempSync on a /Volumes path, the six
#     maintenance_* suites; the whole-suite run left them out for the same
#     reason). A failing suite is rerun the same way on a plain copy of the
#     pinned main. NEXUS_TEST_ROOT points at scratch TheNexus copies (main
#     2a7952fc, plus the TheNexus branch diff for the merged run), as in the
#     59cacac6 check;
#  4. TheCortex: the 11 test files of the earlier merged checks plus main's new
#     tests/test_graph_episode_hold.py, through cortex-tests.sh (every service
#     URL on port 1, the offline network plugin, the conftest's store guard). A
#     failing file is rerun on a plain copy of the pinned main.
# A first run, before the /Volumes exclusion in step 3 was added (scratch names
# ending in 10 and cortex5), was stopped at about 16:32:30 EST once it showed
# that its selection held maintenance_review_regressions. Its output is in
# merged-main-1bac2ea7-b06ed4dc-stopped-run.txt; maintenance-folder-residue.sh
# records and removes the one folder that suite had made.
# Before running it, copy guards/ into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
P=$W/Praxis; C=$W/TheCortex; N=$W/TheNexus
E=$N/docs/reviews/2026-11-23-local-model-control-evidence
for f in praxis-files-guarded.sh cortex-tests.sh lmstudio-guard.mjs net-guard.mjs live-port-guard.mjs fake-lms cli-shims/claude; do
  [ -e $S/$f ] || { echo "$S/$f is missing: copy guards/ into $S first"; exit 1; }
done
PMAIN=$(git -C $P rev-parse 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d^{commit}) || exit 1
PBR=$(git -C $P rev-parse cad6afb2^{commit}) || exit 1
CMAIN=$(git -C $C rev-parse b06ed4dc166c97263d38804a051b506f87e58b85^{commit}) || exit 1
CBR=$(git -C $C rev-parse e611edc^{commit}) || exit 1
NEXUS_MAIN=$(git -C $N rev-parse 2a7952fcc63ea7b26d8148668c76800e73acc5c2^{commit}) || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
touch $S/run-start.marker

fresh() { mkdir -p "$1" || exit 1; [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }

# merged_copy <repo dir> <pinned main> <branch head> <main last checked> <copy dir>: steps 1 and 2.
merged_copy() {
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
  done
  L=$T/tree-files.txt
  git -C $R ls-tree -r $TREE | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "$(basename "$D") against the merge-tree's tree: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3{print $2}' | tr '\n' ' '); extra files in the copy: $(cd "$D" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $L | sort) | wc -l | tr -d ' ')"
}

nexus_copy() { # dir with-branch(yes|no)
  fresh "$S/$1"
  git -C $N archive $NEXUS_MAIN | tar -x -C "$S/$1" || { echo "archive failed"; exit 1; }
  if [ "$2" = yes ]; then
    git -C $N diff --binary bd02642895fe6a914fe04e45af35bee773f3453e 6e14bc87 > $S/nexus-branch-for-praxis11.patch
    (cd "$S/$1" && git apply --whitespace=nowarn $S/nexus-branch-for-praxis11.patch) || { echo "NEXUS APPLY FAILED"; exit 1; }
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

echo "== Praxis: main pinned at $PMAIN, branch $PBR, base 1fcf4b59"
MP=$S/merged-praxis11
merged_copy $P $PMAIN $PBR 59cacac6 $MP
ln -s $P/node_modules "$MP/node_modules"
(cd "$MP" && npx tsc --noEmit > $S/praxis-tsc-merged11.txt 2>&1; echo "exit $?" >> $S/praxis-tsc-merged11.txt)
echo "tsc on the resolved merged tree: $(tail -1 $S/praxis-tsc-merged11.txt) ($(grep -c 'error TS' $S/praxis-tsc-merged11.txt) errors)"
SHARED_DATA=$(cd "$MP" && grep -lE "mkdtempSync\(['\"\`]/Volumes/" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "suites that make their data folder under /Volumes, left out: $(echo $SHARED_DATA | tr '\n' ' ')"
PREV=$(grep . $E/merged-main/praxis-suites152-59cacac6.txt)
CHANGED=$(git -C $P diff --name-only 59cacac6 $PMAIN -- tests | sed -n 's#^tests/\(.*\)\.test\.ts$#\1#p')
MODS=$(git -C $P diff --name-only --diff-filter=d 59cacac6 $PMAIN -- src | sed 's#^src/##; s#\.ts$##' | paste -sd'|' -)
COUPLED=$(cd "$MP" && grep -lE "src/($MODS)(\.js)?['\"]" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##')
echo "source modules main changed since 59cacac6: $(echo $MODS | tr '|' ' ')"
echo "suites main changed since 59cacac6: $(echo $CHANGED | tr '\n' ' ')"
echo "suites importing one of those modules: $(echo $COUPLED | wc -w | tr -d ' ')"
ALL=""; MISSING=""; LEFT_OUT=""
for n in $PREV $CHANGED $COUPLED; do
  case " $ALL $LEFT_OUT " in *" $n "*) continue;; esac
  if echo "$SHARED_DATA" | grep -qx "$n"; then LEFT_OUT="$LEFT_OUT $n"; continue; fi
  if [ -f "$MP/tests/$n.test.ts" ]; then ALL="$ALL $n"; else MISSING="$MISSING $n"; fi
done
echo "suites on the merged tree: $(echo $ALL | wc -w | tr -d ' ') (not on the merged tree:${MISSING:- none}; selected but left out for their /Volumes data folder:${LEFT_OUT:- none}); added to the 152: $(for n in $ALL; do grep -qx "$n" $E/merged-main/praxis-suites152-59cacac6.txt || printf '%s ' "$n"; done)"
echo $ALL | tr ' ' '\n' > $S/praxis-suites-1bac2ea7.txt
nexus_copy nexus-for-merged-praxis11 yes
guarded_with_nexus merged-praxis11 merged11 nexus-for-merged-praxis11 $ALL
FAILING=$(grep -oE "test at tests/[A-Za-z0-9_-]+\.test\.ts" $S/praxis-merged11-run.txt | sed 's#test at tests/##; s#\.test\.ts$##' | sort -u)
echo "suites with failures on the resolved merged tree: $(echo $FAILING | tr '\n' ' ')"
if [ -n "$FAILING" ]; then
  PP=$S/plain-praxis-main11
  fresh "$PP"
  git -C $P archive $PMAIN | tar -x -C "$PP" || { echo "archive failed"; exit 1; }
  ln -s $P/node_modules "$PP/node_modules"
  L=$S/tree-plain-praxis11.txt
  git -C $P ls-tree -r $PMAIN | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "plain-praxis-main11 against $PMAIN: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$PP" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3' | wc -l | tr -d ' ')"
  nexus_copy nexus-for-plain-praxis11 no
  echo "== the same suites on plain main $PMAIN"
  guarded_with_nexus plain-praxis-main11 plain11-failing nexus-for-plain-praxis11 $FAILING
fi
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start.marker | wc -l | tr -d ' ')"

echo "== TheCortex: main pinned at $CMAIN, branch $CBR, base 5fdb76a"
MC=$S/merged-cortex6
merged_copy $C $CMAIN $CBR 3617672 $MC
ln -s $C/TheCortex/.env "$MC/TheCortex/.env"
echo "conftest.py on the resolved tree (pytest import, the store guard and both autouse fixtures):"
grep -n "^import pytest\|^cortex_test_guard.install\|^def local_model_setting_offline\|^def graph_episode_hold_per_test" "$MC/TheCortex/conftest.py"
CT="tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py \
  tests/test_praxis_local_llm_route.py tests/test_client_embedder.py python/test_acted_on_retrieval.py python/test_packet_format.py \
  python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py tests/test_graph_episode_hold.py"
for f in $CT; do [ -f "$MC/TheCortex/$f" ] || echo "MISSING on the merged tree: $f"; done
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merged6-tests.txt $CT
grep -E "cortex_test_guard|passed|failed|error|exit=" $S/cortex-merged6-tests.txt | tail -6
CFAIL=$(grep -oE "^(FAILED|ERROR) [^: ]+\.py" $S/cortex-merged6-tests.txt | awk '{print $2}' | sort -u)
echo "TheCortex files with failures on the resolved merged tree: $(echo $CFAIL | tr '\n' ' ')"
if [ -n "$CFAIL" ]; then
  PC=$S/plain-cortex6
  fresh "$PC"
  git -C $C archive $CMAIN | tar -x -C "$PC" || { echo "archive failed"; exit 1; }
  ln -s $C/TheCortex/.env "$PC/TheCortex/.env"
  echo "== the same files on plain main $CMAIN"
  bash $S/cortex-tests.sh "$PC/TheCortex" $S/cortex-plain6-tests.txt $(echo $CFAIL | sed 's#TheCortex/##g')
  grep -E "cortex_test_guard|passed|failed|error|exit=" $S/cortex-plain6-tests.txt | tail -6
fi
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start.marker | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
