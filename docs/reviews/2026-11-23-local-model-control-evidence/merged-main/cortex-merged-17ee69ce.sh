#!/bin/bash
# Task fa032fc0: at 17:04:50 EST, after the merged checks of
# merged-main-1bac2ea7-b06ed4dc.sh, task 2717b41c (archive the failed bao
# research report's statements out of the knowledge graph) landed on TheCortex
# main (17ee69ce). Praxis main stayed at 1bac2ea7 and TheNexus main at
# 2a7952fc. Since b06ed4dc, main changed AGENTS.md and CLAUDE.md and added
# TheCortex/scripts/archive_failed_research_ingest.py; the branch touches none
# of them. This script repeats the TheCortex part of
# merged-main-1bac2ea7-b06ed4dc.sh on the new main, outside every repository
# (no worktree, branch or clone):
#  1. git merge-tree --write-tree on main 17ee69ce and the branch head e611edc,
#     and each conflict hunk as git merge-file --diff3 shows it;
#  2. a scratch copy of the merge-tree's tree with each conflicted file resolved
#     the way git merge-file --union does, checked file by file against that
#     tree; then the resolved conftest.py against the one the b06ed4dc check
#     tested, and the whole copy against that check's copy (merged-cortex6);
#  3. the same 12 test files through cortex-tests.sh (every service URL on
#     port 1, the offline network plugin, the conftest's store guard). A
#     failing file is rerun on a plain copy of main 17ee69ce.
# Before running it, copy guards/ into the scratch folder (see the README).
# The comparison in step 2 needs merged-cortex6, which
# merged-main-1bac2ea7-b06ed4dc.sh builds.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
C=$W/TheCortex
[ -e $S/cortex-tests.sh ] || { echo "$S/cortex-tests.sh is missing: copy guards/ into $S first"; exit 1; }
[ -d $S/merged-cortex6 ] || { echo "$S/merged-cortex6 is missing: run merged-main-1bac2ea7-b06ed4dc.sh first"; exit 1; }
CMAIN=$(git -C $C rev-parse 17ee69cebb5c1403dbef27929d19963134e8bec8^{commit}) || exit 1
CBR=$(git -C $C rev-parse e611edc^{commit}) || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
touch $S/run-start-cortex7.marker

fresh() { mkdir -p "$1" || exit 1; [ -z "$(ls -A "$1")" ] || { echo "$1 is not empty, stopping"; exit 1; }; }

# merged_copy as in merged-main-1bac2ea7-b06ed4dc.sh: steps 1 and 2.
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
  done
  L=$T/tree-files.txt
  git -C $R ls-tree -r $TREE | awk -F'\t' '{split($1,a," "); if (a[2]=="blob" && a[1]!="120000") print a[3]"\t"$2}' > $L
  echo "$(basename "$D") against the merge-tree's tree: $(wc -l < $L | tr -d ' ') files compared; differing: $(paste $L <(cut -f2 $L | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk -F'\t' '$1!=$3{print $2}' | tr '\n' ' '); extra files in the copy: $(cd "$D" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(cut -f2 $L | sort) | wc -l | tr -d ' ')"
}

echo "== TheCortex: main pinned at $CMAIN, branch $CBR, base 5fdb76a"
MC=$S/merged-cortex7
merged_copy $C $CMAIN $CBR b06ed4dc166c97263d38804a051b506f87e58b85 $MC
ln -s $C/TheCortex/.env "$MC/TheCortex/.env"
if cmp -s "$MC/TheCortex/conftest.py" "$S/merged-cortex6/TheCortex/conftest.py"; then
  echo "resolved conftest.py: identical to the one the b06ed4dc check tested"
else
  echo "resolved conftest.py: DIFFERS from the one the b06ed4dc check tested"
fi
echo "the whole copy against merged-cortex6 (the b06ed4dc check's copy), diff -rq:"
diff -rq "$S/merged-cortex6" "$MC" | sed "s#$S/##g"
echo "(end of diff)"
CT="tests/test_local_model_setting.py tests/test_graphiti_llm_provider.py tests/test_relevance_labels.py tests/test_llm_factory_nexus_sync.py \
  tests/test_praxis_local_llm_route.py tests/test_client_embedder.py python/test_acted_on_retrieval.py python/test_packet_format.py \
  python/test_citation_recovery.py python/test_curation_replay.py python/test_eval_referee.py tests/test_graph_episode_hold.py"
for f in $CT; do [ -f "$MC/TheCortex/$f" ] || echo "MISSING on the merged tree: $f"; done
echo "files of the merged tree that name archive_failed_research_ingest, besides the script itself: $(grep -rl archive_failed_research_ingest "$MC" | sed "s#$MC/##" | grep -v '^TheCortex/scripts/archive_failed_research_ingest.py$' | tr '\n' ' ')"
touch $S/cortex-merged7-tests.marker
bash $S/cortex-tests.sh "$MC/TheCortex" $S/cortex-merged7-tests.txt $CT
grep -E "cortex_test_guard|passed|failed|error|exit=" $S/cortex-merged7-tests.txt | tail -6
CFAIL=$(grep -oE "^(FAILED|ERROR) [^: ]+\.py" $S/cortex-merged7-tests.txt | awk '{print $2}' | sort -u)
echo "TheCortex files with failures on the resolved merged tree: $(echo $CFAIL | tr '\n' ' ')"
if [ -n "$CFAIL" ]; then
  PC=$S/plain-cortex7
  fresh "$PC"
  git -C $C archive $CMAIN | tar -x -C "$PC" || { echo "archive failed"; exit 1; }
  ln -s $C/TheCortex/.env "$PC/TheCortex/.env"
  echo "== the same files on plain main $CMAIN"
  bash $S/cortex-tests.sh "$PC/TheCortex" $S/cortex-plain7-tests.txt $(echo $CFAIL | sed 's#TheCortex/##g')
  grep -E "cortex_test_guard|passed|failed|error|exit=" $S/cortex-plain7-tests.txt | tail -6
fi
echo "files written in the merged copy since its test run started: $(find "$MC" -newer $S/cortex-merged7-tests.marker -type f | wc -l | tr -d ' ')"
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since this script started: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newer $S/run-start-cortex7.marker | wc -l | tr -d ' ')"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "== done"
