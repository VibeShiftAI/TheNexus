#!/bin/bash
# Task fa032fc0: checks that each scratch copy holds exactly the git tree it was
# built from (every tracked file under src, tests and scripts hashed with git
# hash-object and compared with git ls-tree), and lists files the copy has that
# the tree does not. Read-only.
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
S=/Volumes/Projects/.scratch-fa032fc0
check() {
  local D=$S/$1 REV=$2 T
  T=$(mktemp)
  git -C $P ls-tree -r "$REV" -- src tests scripts package.json | awk -F'\t' '{split($1,a," "); print a[3]"\t"$2}' > "$T"
  local n mism extra
  n=$(wc -l < "$T" | tr -d ' ')
  mism=$(paste <(cut -f1 "$T") <(cut -f2 "$T" | (cd "$D" && git hash-object --no-filters --stdin-paths)) | awk '$1!=$2' | wc -l | tr -d ' ')
  extra=$(cd "$D" && find src tests scripts -type f | sort | comm -23 - <(cut -f2 "$T" | sort))
  echo "$1 against $REV: $n tracked files compared, $mism differ, $(printf '%s' "$extra" | grep -c .) extra files in the copy"
  [ -n "$extra" ] && printf '%s\n' "$extra" | head -10 | sed 's/^/   extra: /'
  rm -f "$T"
}
# The merged copies are compared with the tree git itself writes for the real
# merge of that main with the branch head (git merge-tree, which writes objects
# only, and changes no ref, index or working tree).
check plain-praxis-main4 4d076f91
check merged-praxis5 "$(git -C $P merge-tree --write-tree 4d076f91 cad6afb2 | head -1)"
check plain-praxis-main6 613f66b6
check merged-praxis6 "$(git -C $P merge-tree --write-tree 613f66b6 cad6afb2 | head -1)"
