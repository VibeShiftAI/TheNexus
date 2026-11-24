#!/bin/bash
# Task fa032fc0: the 144 suites of the 519530a9 merged check, once more on the
# merged tree and once on plain 519530a9, one after the other under the same
# guards, to compare the failures under the same load.
S=/Volumes/Projects/.scratch-fa032fc0
echo "start $(date '+%H:%M:%S %Z')"
bash $S/praxis-files-guarded.sh $S/merged-praxis8 merged8-rerun $(cat $S/suites144.txt) | sed 1d
echo "merged rerun done $(date '+%H:%M:%S %Z')"
bash $S/praxis-files-guarded.sh $S/plain-praxis-main8 plain8-all $(cat $S/suites144.txt) | sed 1d
echo "plain done $(date '+%H:%M:%S %Z')"
