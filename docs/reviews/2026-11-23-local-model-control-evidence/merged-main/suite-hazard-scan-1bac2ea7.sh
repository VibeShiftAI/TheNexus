#!/bin/bash
# Task fa032fc0: the scan of the Praxis suites picked for the merged check on
# main 1bac2ea7 (merged-main-1bac2ea7-b06ed4dc.sh). The first run of that check
# picked its suites by import without this scan and was stopped (see
# maintenance-folder-residue.sh); this is the scan made before the rerun, run
# again over the rerun's copy so its output can be kept. Read-only: grep over the
# copy's test files, nothing runs. It needs that copy, which step 2 of
# merged-main-1bac2ea7-b06ed4dc.sh builds as $S/merged-praxis11: once the
# scratch folder is gone, run that script first.
#  1. Every suite in the rerun's selection (praxis-suites179-1bac2ea7.txt), plus
#     maintenance_review_regressions, which the first run had picked: each line
#     that names a path under /Volumes/Projects, a home folder, or one of the
#     live ports (LM Studio 1234, the dashboards 3000 and 3777, Nexus 4000 and
#     4199, TheCortex 8100, the Praxis bridge 54322).
#  2. Every suite in the copy that makes a folder under /Volumes with
#     fs.mkdtempSync, the reason the selection leaves those suites out.
#  3. Which of the 27 suites added to the 152 of the 59cacac6 check have a line
#     in step 1.
S=/Volumes/Projects/.scratch-fa032fc0
M=$S/merged-praxis11
E=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus/docs/reviews/2026-11-23-local-model-control-evidence/merged-main
cd $M || exit 1
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z'), read-only, over $M"
LIST="$(cat $E/praxis-suites179-1bac2ea7.txt) maintenance_review_regressions"
PATTERN="/Volumes/Projects|os\.homedir|homedir\(\)|process\.env\.HOME|~/|(127\.0\.0\.1|localhost):(4000|8100|1234|3000|3777|4199|54322)"
echo "suites scanned: $(echo $LIST | wc -w | tr -d ' ')"
echo
echo "== 1. lines naming /Volumes/Projects, a home folder or a live port"
HIT=""
for n in $LIST; do
  hits=$(grep -n -E "$PATTERN" tests/$n.test.ts | cut -c1-170)
  if [ -n "$hits" ]; then
    HIT="$HIT $n"
    echo "-- $n ($(echo "$hits" | wc -l | tr -d ' ') lines)"
    echo "$hits"
  fi
done
echo
echo "== 2. suites in the copy that make a folder under /Volumes (fs.mkdtempSync)"
grep -l -E "mkdtempSync\(['\"\`]/Volumes/" tests/*.test.ts | sed 's#^tests/##; s#\.test\.ts$##'
echo
echo "== 3. the 27 suites added to the 152, and which have a line in step 1"
ADDED=$(comm -13 <(sort $E/praxis-suites152-59cacac6.txt) <(sort $E/praxis-suites179-1bac2ea7.txt))
echo "added: $(echo $ADDED | wc -w | tr -d ' ')"
for n in $ADDED; do
  case " $HIT " in *" $n "*) echo "  $n: has lines in step 1";; *) echo "  $n: none";; esac
done
echo "# done"
