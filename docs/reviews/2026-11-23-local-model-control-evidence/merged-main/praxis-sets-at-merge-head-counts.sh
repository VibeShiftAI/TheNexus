#!/bin/bash
# Task fa032fc0, merge-conflict repair: why the round-7 sets count other numbers
# of tests on the merge commit 15b19a5c than on the round-7 head 196a5375
# (praxis-sets-at-merge-head-output.txt against praxis-round7-sets-output.txt).
# For each set it lists the test files that differ between the two commits (the
# merge brought main's changes to them), then counts the node:test
# declarations, test( and t.test( calls (it( as well), in each of them at both
# commits, and says whether the merged file is main's and whether the branch
# changed it. Read-only git queries.
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
A=196a537506d8b9076753ee1143cd527c3ac6eb14; B=15b19a5c147523c436b4f2783ca68c5e9e1c7843
M=1bac2ea7901c8203a1ba271b555fbc3c2a1d8d7d; MB=1fcf4b5940d7fd3ffb8b70751c8409d53c0e884c
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only"
count() { # <commit> <file>: declarations, or "absent"
  [ -z "$(git -C $P ls-tree $1 -- $2)" ] && { echo absent; return; }
  git -C $P show $1:$2 | grep -cE '(^|[^.a-zA-Z_])(test|it)(\.only|\.skip)?\(|\bt\.test\('
}
show() { # <set name> <names...>
  local name=$1; shift; local files="" f
  for n in "$@"; do files="$files tests/$n.test.ts"; done
  echo
  echo "== $name ($# names): test files that differ between 196a5375 and 15b19a5c"
  git -C $P diff --stat $A $B -- $files | cat
  for f in $(git -C $P diff --name-only $A $B -- $files); do
    same_main=no; [ "$(git -C $P rev-parse -q --verify $B:$f)" = "$(git -C $P rev-parse -q --verify $M:$f)" ] && same_main=yes
    branch=no; [ -n "$(git -C $P diff --name-only $MB $A -- $f)" ] && branch=yes
    echo "  $f: declarations at 196a5375 $(count $A $f), at 15b19a5c $(count $B $f); at 15b19a5c the same as on main 1bac2ea7 (or absent from both): $same_main; changed by the branch (1fcf4b59..196a5375): $branch"
  done
}
show selection local_model_selection local_model_demand_callers local_lane_policy
show related $(tr '\n' ' ' < $E/praxis-round5-related-names.txt)
show more-related $(tr '\n' ' ' < $E/praxis-round5-more-related-names.txt) lane_credit
show wider $(grep -vx maintenance_review_regressions $E/praxis-wider-test-list.txt | tr '\n' ' ')
