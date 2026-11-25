#!/bin/bash
# The rerun of the wider Praxis set on a8caeb09 (tag wider-r5c), then
# praxis-chat-turn-steps-alone.sh. It was typed in the session as one command
# at 18:48:55 EST; written down here as it ran, one step per line. Its output is
# praxis-round5-rerun-output.txt.
#
# Why: the first wider run on a8caeb09 (praxis-round5-a8caeb09-sets.sh) caught
# 3 CLI runs and 3 requests from chat_turn_steps_legacy, where round 4's wider
# run caught 6 and 6, and the CLI shim log of that run was emptied by a later
# guarded run before it was copied. praxis-wider-run.sh now keeps each run's
# shim log under its tag (cli-shims-<tag>.log). Before running this, copy guards/
# into the scratch folder (see the README).
S=/Volumes/Projects/.scratch-fa032fc0
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
ls -d $S/praxis-cad6afb2-alone 2>/dev/null
echo "head before: $(git -C $P rev-parse HEAD) status: $(git -C $P status --porcelain | wc -l)" > $S/r5c-output.txt
TAG=wider-r5c bash $E/praxis-wider-run.sh >> $S/r5c-output.txt 2>&1
echo "== alone" >> $S/r5c-output.txt
bash $E/praxis-chat-turn-steps-alone.sh > $S/praxis-chat-turn-steps-alone-output.txt 2>&1
echo "alone exit $?" >> $S/r5c-output.txt
echo "head after: $(git -C $P rev-parse HEAD) status: $(git -C $P status --porcelain | wc -l)" >> $S/r5c-output.txt
cat $S/r5c-output.txt
