#!/bin/bash
# Task fa032fc0, criterion 1: the readiness task's commits (task 9227d9b6, found
# by its trailer) are on main in each repository, and each task branch is built
# on them. Then the brief's own check, run as the brief writes it. Read-only git
# queries.
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
echo "# Criterion 1 precondition check, $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
for r in TheNexus Praxis TheCortex; do
  G="git -C $W/$r"
  echo
  # The merge-base was the QA baseline until the merge-conflict repair merged
  # main into the Praxis and TheCortex branches; since then it is main itself.
  echo "== $r: main $($G rev-parse --short=8 main), branch head $($G rev-parse --short=8 HEAD), merge-base with main $($G merge-base main HEAD | cut -c1-8)"
  n=0
  while read -r full; do
    n=$((n + 1))
    on_main=no; $G merge-base --is-ancestor "$full" main && on_main=yes
    under=no; $G merge-base --is-ancestor "$full" HEAD && under=yes
    echo "  $($G log -1 --format='%h %ci' "$full") on main: $on_main; under the branch head: $under; $($G log -1 --format=%s "$full" | cut -c1-110)"
  done < <($G log main --grep='9227d9b6' --format='%H')
  echo "  commits with the 9227d9b6 trailer on main: $n"
done
echo
echo "== The brief's check, as written: git -C /Volumes/Projects/Praxis grep -c 'thinkingmachines/inkling-2-mini' main -- src/llm/local-model-capabilities.ts"
echo "   (a count means the readiness task has landed; no output and exit 1 means it has not)"
git -C /Volumes/Projects/Praxis grep -c 'thinkingmachines/inkling-2-mini' main -- src/llm/local-model-capabilities.ts
echo "   exit $?"
