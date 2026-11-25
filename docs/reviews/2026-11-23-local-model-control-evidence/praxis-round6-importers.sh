#!/bin/bash
# Which Praxis test files name a module that round 5 or round 6 changed
# (src/council/member-profile-updates.ts, src/llm/local-lane-policy.ts,
# src/llm/lmstudio-autoload.ts, src/llm/providers.ts, src/llm/manager.ts,
# src/llm/local-model-state.ts, src/voice/spoken-prose.ts) or the output-room
# wrapper, and which of them are in none of the three lists the Praxis runs used:
# the 40 related files, the 9 more-related files of round 4, and the wider list
# (praxis-wider-test-list.txt).
#
# "Name" is what the grep below matches: the module's path anywhere in the file,
# in an import or in a comment. praxis-round5-importers.sh said "importing" for
# the same match, which was wrong for one file: lane_credit names llm/manager only
# in a comment (lane_credit.test.ts:103). It was run all the same (the
# more-related run adds it), and it is listed here for the same reason.
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
P=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'); Praxis at $(git -C $P rev-parse --short=8 HEAD), $(git -C $P status --porcelain | wc -l | tr -d ' ') changed files"
PATTERN="member-profile-updates|local-lane-policy|lmstudio-autoload|llm/providers|llm/manager|local-model-state|output-room|spoken-prose"
NAMERS=$(cd $P && grep -lE "$PATTERN" tests/*.test.ts | sed 's|tests/||; s|\.test\.ts||' | sort -u)
COVERED=$(cat $E/praxis-round5-related-names.txt $E/praxis-round5-more-related-names.txt $E/praxis-wider-test-list.txt | sort -u)
echo "test files naming one of those modules: $(echo "$NAMERS" | wc -l | tr -d ' ')"
echo "names in the three lists: $(echo "$COVERED" | wc -l | tr -d ' ')"
echo "test files naming spoken-prose:"
(cd $P && grep -lE "spoken-prose" tests/*.test.ts | sed 's|tests/||; s|\.test\.ts||; s/^/  /')
echo "naming files in none of the three lists:"
comm -23 <(echo "$NAMERS") <(echo "$COVERED") | sed 's/^/  /'
echo "of those, the ones that name a module only outside an import line (line:name matched):"
for n in $(comm -23 <(echo "$NAMERS") <(echo "$COVERED")); do
  if ! grep -E "^\s*(import|const .*await import|} from)" "$P/tests/$n.test.ts" | grep -qE "$PATTERN"; then
    echo "  $n: $(grep -noE "$PATTERN" "$P/tests/$n.test.ts" | head -3 | tr '\n' ' ')"
    echo "    import lines naming one: $(grep -cE "^\s*(import|const .*await import|} from).*($PATTERN)" "$P/tests/$n.test.ts")"
  fi
done
