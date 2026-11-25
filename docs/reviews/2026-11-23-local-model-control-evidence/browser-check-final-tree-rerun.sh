#!/bin/bash
# Task fa032fc0: rerun the real-browser check on the final TheNexus tree (HEAD),
# from a scratch copy, so its screenshots land in the copy and the registered
# review package in the worktree stays byte-for-byte as registered.
S=/Volumes/Projects/.scratch-fa032fc0
N=/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/TheNexus
B=$S/browser-final
for l in "$B/node_modules" "$B/dashboard/node_modules"; do [ -L "$l" ] && rm -f "$l"; done
rm -rf "$B" && mkdir -p "$B"
git -C $N archive HEAD | tar -x -C "$B" || { echo "archive failed"; exit 1; }
ln -s $N/node_modules "$B/node_modules"
ln -s $N/dashboard/node_modules "$B/dashboard/node_modules"
echo "tree: TheNexus $(git -C $N rev-parse --short HEAD) (status: $(git -C $N status --short | wc -l | tr -d ' ') changed files)"
shasum -a 256 $N/docs/reviews/2026-11-23-local-model-control/*.png > $S/package-png-sha-before.txt
(cd "$B" && node docs/reviews/2026-11-23-local-model-control-evidence/local-model-browser-check.mjs > $S/browser-check-final.txt 2>&1; echo "exit $?" >> $S/browser-check-final.txt)
shasum -a 256 $N/docs/reviews/2026-11-23-local-model-control/*.png > $S/package-png-sha-after.txt
echo "CHECK_OK: $(grep -c CHECK_OK $S/browser-check-final.txt)  CHECK_FAIL: $(grep -c CHECK_FAIL $S/browser-check-final.txt)"
grep -E "CHECK_FAIL|CHECK_RESULT|^exit" $S/browser-check-final.txt | head -20
cmp -s $S/package-png-sha-before.txt $S/package-png-sha-after.txt && echo "registered package PNGs unchanged" || echo "PACKAGE PNGS CHANGED"
