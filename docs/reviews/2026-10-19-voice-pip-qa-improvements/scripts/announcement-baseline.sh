#!/bin/bash
# Run voice-command-bar.test.ts on clean committed snapshots, without touching the shared tree.
set -u
REPO=/Volumes/Projects/TheNexus
for rev in "$@"; do
  dir=/tmp/voice-pip-snap-$rev
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$REPO" archive "$rev" dashboard | tar -x -C "$dir"
  ln -s "$REPO/dashboard/node_modules" "$dir/dashboard/node_modules"
  (cd "$dir/dashboard" && node --import ./test/register.mjs --test src/lib/__tests__/voice-command-bar.test.ts > "/tmp/voice-pip-snap-$rev.log" 2>&1)
  echo "== $rev ($(git -C "$REPO" log -1 --format='%h %cI %s' "$rev")) exit=$?"
  grep -E "^ℹ (tests|pass|fail)" "/tmp/voice-pip-snap-$rev.log"
  awk '/^✖ failing tests:/{f=1;next} f && /^✖ /{sub(/ \([0-9.]+ms\)$/,"");print}' "/tmp/voice-pip-snap-$rev.log" | sort -u > "/tmp/voice-pip-snap-$rev.failing"
  cat "/tmp/voice-pip-snap-$rev.failing"
done
