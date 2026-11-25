#!/bin/bash
# tests/chat_turn_steps_legacy.test.ts alone, twice on the branch head a8caeb09
# (the clean worktree) and twice on round 4's head cad6afb2 (a fresh scratch copy
# made with git archive), each under praxis-files-guarded.sh. The suite is
# unchanged by this task. It spawns the agy, claude and codex CLIs and posts to
# openrouter.ai, and the CLI shims and the network guard refuse all of it. In the
# wider run on a8caeb09 the guards caught 3 CLI runs and 3 requests from it,
# where round 4's wider run on cad6afb2 caught 6 and 6; these runs show what it
# makes alone on each head. Before running it, copy guards/ into the scratch
# folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
OLD=$S/praxis-cad6afb2-alone
[ -e $S/praxis-files-guarded.sh ] || { echo "$S/praxis-files-guarded.sh is missing: copy guards/ into $S first"; exit 1; }
[ "$(git -C $P rev-parse HEAD)" = a8caeb0943e83bfeac10671cc019f59a499c8277 ] || { echo "the Praxis worktree is not at a8caeb09, stopping"; exit 1; }
[ -z "$(git -C $P status --porcelain)" ] || { echo "the Praxis worktree has changes, stopping"; exit 1; }
mkdir -p $OLD && [ -z "$(ls -A $OLD)" ] || { echo "$OLD is not empty, stopping"; exit 1; }
git -C $P archive cad6afb2 | tar -x -C $OLD || { echo "archive failed"; exit 1; }
ln -s $P/node_modules $OLD/node_modules
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'); new = $P at $(git -C $P rev-parse --short=8 HEAD), old = $OLD (git archive cad6afb2)"
for run in new-1 new-2 old-1 old-2; do
  case $run in new-*) DIR=$P ;; old-*) DIR=$OLD ;; esac
  bash $S/praxis-files-guarded.sh $DIR ctsl5-$run chat_turn_steps_legacy | sed -n '1,2p'
  echo "   CLI shim calls: $(wc -l < $S/cli-shims-ctsl5-$run.log | tr -d ' '); network guard refusals: $(cat $S/net-guard-ctsl5-$run.log 2>/dev/null | wc -l | tr -d ' '); LM Studio guard: $(wc -l < $S/lmstudio-guard-ctsl5-$run.log | tr -d ' '); live-port guard: $(wc -l < $S/live-port-guard-ctsl5-$run.log | tr -d ' ')"
  sed 's/^/     shim: /' $S/cli-shims-ctsl5-$run.log
  cat $S/net-guard-ctsl5-$run.log 2>/dev/null | cut -c1-160 | sed 's/^/     net: /'
done
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
