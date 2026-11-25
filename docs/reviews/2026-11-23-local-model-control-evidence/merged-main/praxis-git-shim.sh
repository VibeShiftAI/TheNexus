#!/bin/bash
# Read-only git shim for one test on a plain-directory tree: forwards exactly
# `git show 1cac649:src/webhook.ts` to the Praxis object store; logs and refuses
# every other git command.
if [ "$#" -eq 2 ] && [ "$1" = "show" ] && [ "$2" = "1cac649:src/webhook.ts" ]; then
  echo "forwarded: $*" >> /Volumes/Projects/.scratch-fa032fc0/git-shim.log
  exec env GIT_DIR=/Volumes/Projects/Praxis/.git /usr/bin/git show 1cac649:src/webhook.ts
fi
echo "refused: $*" >> /Volumes/Projects/.scratch-fa032fc0/git-shim.log
echo "git shim: refused $*" >&2
exit 1
