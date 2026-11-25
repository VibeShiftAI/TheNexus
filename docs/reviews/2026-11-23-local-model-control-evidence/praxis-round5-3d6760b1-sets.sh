#!/bin/bash
echo "Praxis head: $(git -C /Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis log -1 --format=%H)"
bash /Volumes/Projects/.scratch-fa032fc0/praxis-files-guarded.sh /Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis related-r5 $(tr '\n' ' ' < /Volumes/Projects/.scratch-fa032fc0/related-names.txt)
bash /Volumes/Projects/.scratch-fa032fc0/praxis-files-guarded.sh /Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis more-related-r5 $(tr '\n' ' ' < /Volumes/Projects/.scratch-fa032fc0/more-related-names.txt) lane_credit
TAG=wider-r5 bash /Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence/praxis-wider-run.sh
