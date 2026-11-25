#!/bin/bash
# Task fa032fc0, merge-conflict repair: criterion-2-sites.sh names each site's
# "Now" lines at the branch heads Praxis 196a5375 and TheCortex 892708c8. The
# repair merged main into both branches (Praxis 15b19a5c, TheCortex 1eca58eb),
# which moves lines in files main also changed. This runs criterion-2-sites.sh
# unchanged except for its line 10, with the two heads replaced by the merge
# commits (TheNexus did not merge: its head is unchanged), then diffs that output
# against criterion-2-sites.txt (20:40:09 EST, at 196a5375 and 892708c8) with
# each merge commit's name written as the head it merged, so the diff shows
# only the lines that moved or changed. Read-only git queries; it writes only in
# the scratch folder.
S=/Volumes/Projects/.scratch-fa032fc0
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence
OLD='PB=1fcf4b59; PH=196a5375; NB=bd02642895fe; NH=6e14bc87; CB=5fdb76a; CH=892708c8'
NEW='PB=1fcf4b59; PH=15b19a5c; NB=bd02642895fe; NH=6e14bc87; CB=5fdb76a; CH=1eca58eb'
[ "$(sed -n 10p $E/criterion-2-sites.sh)" = "$OLD" ] || { echo "line 10 of criterion-2-sites.sh is not the expected one, stopping"; exit 1; }
sed "10s/^.*\$/$NEW/" $E/criterion-2-sites.sh > $S/criterion-2-sites-merge-commits.sh
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "lines that differ between criterion-2-sites.sh and the copy run here: $(diff $E/criterion-2-sites.sh $S/criterion-2-sites-merge-commits.sh | grep -c '^[<>]') (line 10 on each side)"
bash $S/criterion-2-sites-merge-commits.sh > $S/criterion-2-sites-merge-commits.txt 2>&1
echo "output: $(wc -l < $S/criterion-2-sites-merge-commits.txt | tr -d ' ') lines (criterion-2-sites.txt: $(wc -l < $E/criterion-2-sites.txt | tr -d ' '))"
echo "== the diff, the 20:40:09 output (<) against the merge commits (>), after the first line (the time), with 15b19a5c written as 196a5375 and 1eca58eb as 892708c8:"
diff <(sed 1d $E/criterion-2-sites.txt) <(sed 1d $S/criterion-2-sites-merge-commits.txt | sed 's/15b19a5c/196a5375/g; s/1eca58eb/892708c8/g')
echo "== diff exit $? (0 = the same)"
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
