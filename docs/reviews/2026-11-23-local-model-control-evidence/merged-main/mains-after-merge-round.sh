#!/bin/bash
# Task fa032fc0, merge-conflict repair: the last check of the three mains.
# Read-only (git --no-optional-locks in each shared checkout, plain reads in the
# task worktrees). For each repository it prints main now and its last reflog
# entry, the commits main gained since the main this task last merged or checked
# against (TheNexus 2a7952fc, Praxis 1bac2ea7, TheCortex 17ee69ce), the folders
# those commits touch, the files they share with the branch's own changes, the
# exit code of `git merge-tree --write-tree main HEAD` in the task worktree
# (0 = merges without a conflict) and the worktree's head and status.
W=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
check() { # <repo> <main last merged or checked> <base of the branch's own changes>
  local r=$1 old=$2 base=$3
  local g="git --no-optional-locks -C /Volumes/Projects/$r"
  local new; new=$($g rev-parse main)
  echo
  echo "== $r: main $new ($($g reflog show --date=iso main -1 --format='%gd: %gs' | cut -c1-110))"
  echo "commits since ${old:0:8}:"
  $g log --format='  %h %ad %s' --date=format:'%Y-%m-%d %H:%M:%S' "$old..$new" | cut -c1-140
  echo "files they change, by folder (status, first two path parts):"
  $g diff --name-status "$old" "$new" | awk '{print $1, $2}' | sed -E 's#^([A-Z]) ([^/]+/[^/]+)/.*#\1 \2/...#' | sort | uniq -c | sed 's/^/ /'
  local mainfiles branchfiles both
  mainfiles=$($g diff --name-only "$old" "$new" | sort)
  branchfiles=$( (git -C "$W/$r" diff --name-only "$base" HEAD; git -C "$W/$r" diff --name-only HEAD; git -C "$W/$r" ls-files --others --exclude-standard) | sort -u)
  both=$(comm -12 <(echo "$mainfiles") <(echo "$branchfiles"))
  echo "files main changed: $(echo "$mainfiles" | grep -c .); files the branch changes (${base:0:8}..HEAD plus the working tree): $(echo "$branchfiles" | grep -c .); in both: $(echo "$both" | grep -c .)"
  [ -n "$both" ] && echo "$both" | sed 's/^/  /'
  git -C "$W/$r" merge-tree --write-tree main HEAD > /dev/null 2>&1
  echo "merge-tree --write-tree main HEAD in the task worktree: exit $?"
  echo "task worktree head: $(git -C "$W/$r" rev-parse HEAD); changed paths: $(git -C "$W/$r" status --porcelain | wc -l | tr -d ' '), outside docs/reviews/2026-11-23-local-model-control-evidence/: $(git -C "$W/$r" status --porcelain | grep -vc ' docs/reviews/2026-11-23-local-model-control-evidence/')"
}
check TheNexus 2a7952fcc63ea7b26d8148668c76800e73acc5c2 bd02642895fe6a914fe04e45af35bee773f3453e
check Praxis 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d 1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d
check TheCortex 17ee69cebb5c1403dbef27929d19963134e8bec8 17ee69cebb5c1403dbef27929d19963134e8bec8
