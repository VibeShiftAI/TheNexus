#!/bin/bash
# Task fa032fc0: the three files where the task branches conflict with Praxis
# main 1bac2ea7 and TheCortex main b06ed4dc, each shown as a unified diff from
# the file with conflict markers (git merge-file --diff3) to the file
# merged-main-1bac2ea7-b06ed4dc.sh resolved and tested (git merge-file
# --union). Lines starting with "-" are what the resolution drops. Reads git
# objects only; its scratch files go under the scratch folder.
S=/Volumes/Projects/.scratch-fa032fc0
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
T=$S/conflict-resolutions; mkdir -p $T || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
show() { # repo main branch
  local R=$W/$1 OUT F B M X n
  OUT=$(git -C $R merge-tree --write-tree $2 $3 2>&1)
  for F in $(echo "$OUT" | awk -F'\t' '/^[0-7]+ [0-9a-f]+ [123]\t/{print $2}' | sort -u); do
    B=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 1$/{split($1,a," "); print a[2]}')
    M=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 2$/{split($1,a," "); print a[2]}')
    X=$(echo "$OUT" | awk -F'\t' -v f="$F" '$2==f && $1 ~ / 3$/{split($1,a," "); print a[2]}')
    n=$(basename "$F")
    git -C $R cat-file -p $B > $T/$n.base; git -C $R cat-file -p $M > $T/$n.main; git -C $R cat-file -p $X > $T/$n.branch
    cp $T/$n.main $T/$n.marked; git merge-file --diff3 -L main -L base -L branch $T/$n.marked $T/$n.base $T/$n.branch
    cp $T/$n.main $T/$n.resolved; git merge-file --union $T/$n.resolved $T/$n.base $T/$n.branch
    echo
    echo "== $1 $F (main ${2:0:8}, branch ${3:0:8})"
    diff -u --label "$F with conflict markers" --label "$F resolved" $T/$n.marked $T/$n.resolved
  done
}
show Praxis 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d cad6afb2
show TheCortex b06ed4dc166c97263d38804a051b506f87e58b85 e611edc
echo
echo "# done"
