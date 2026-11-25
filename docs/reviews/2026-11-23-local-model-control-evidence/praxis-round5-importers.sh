#!/bin/bash
# Which Praxis test files import a module round 5 changed
# (src/council/member-profile-updates.ts, src/llm/local-lane-policy.ts,
# src/llm/lmstudio-autoload.ts, src/llm/providers.ts, src/llm/manager.ts) or the
# local model state and the output-room wrapper, and which of them are in none of
# the three lists the Praxis runs used: the 40 related files, the 9 more-related
# files of round 4, and the wider list (praxis-wider-test-list.txt).
#
# The same check first ran inline at 18:31 EST on 3d6760b1. It named one file,
# lane_credit, which was then added to the more-related run. a8caeb09 changed no
# test file and no import, so the check gives the same answer on it.
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'); Praxis at $(git -C $P rev-parse --short=8 HEAD), $(git -C $P status --porcelain | wc -l | tr -d ' ') changed files"
IMPORTERS=$(cd $P && grep -lE "member-profile-updates|local-lane-policy|lmstudio-autoload|llm/providers|llm/manager|local-model-state|output-room" tests/*.test.ts | sed 's|tests/||; s|\.test\.ts||' | sort -u)
COVERED=$(cat $E/praxis-round5-related-names.txt $E/praxis-round5-more-related-names.txt $E/praxis-wider-test-list.txt | sort -u)
echo "test files importing one of those modules: $(echo "$IMPORTERS" | wc -l | tr -d ' ')"
echo "names in the three lists: $(echo "$COVERED" | wc -l | tr -d ' ')"
echo "importers in none of the three lists:"
comm -23 <(echo "$IMPORTERS") <(echo "$COVERED") | sed 's/^/  /'
