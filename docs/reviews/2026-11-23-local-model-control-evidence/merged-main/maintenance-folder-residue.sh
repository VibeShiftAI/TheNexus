#!/bin/bash
# Task fa032fc0: the first run of merged-main-1bac2ea7-b06ed4dc.sh (started
# 16:31:37 EST, stopped about 16:32:30) picked its suites by import and so
# included maintenance_review_regressions, which this task's earlier runs left
# out: it sets PRAXIS_DATA_DIR to fs.mkdtempSync under
# /Volumes/Projects/maintenance-mode-worktrees (a shared folder) instead of the
# system temp folder. Everything the suite writes goes inside that folder, and
# its one model call is mocked (t.mock.method on llmManager.complete). The run
# was stopped before the suite cleaned up, which left the folder below. This
# script shows it (times and contents), removes it with rmdir (which refuses
# any folder that is not empty) and shows that nothing else in the shared
# folder changed after the run started.
D=/Volumes/Projects/maintenance-mode-worktrees/review-regressions-4K2BvL
echo "# $(date '+%Y-%m-%d %H:%M:%S %Z')"
for p in $D $D/leases $D/logs; do stat -f '%N  born %SB  modified %Sm  size %z' -t '%Y-%m-%d %H:%M:%S' $p; done
echo "entries inside other than these two folders: $(find $D -mindepth 1 | grep -cvE "^$D/(leases|logs)$")"
rmdir $D/leases $D/logs $D && echo "removed with rmdir"
ls -d $D 2>&1
echo "entries in /Volumes/Projects/maintenance-mode-worktrees changed since 16:31:00, other than the folder itself: $(find /Volumes/Projects/maintenance-mode-worktrees -mindepth 1 -newermt '2026-11-24 16:31:00' | wc -l | tr -d ' ')"
