#!/bin/bash
S=/Volumes/Projects/.scratch-fa032fc0
MP=$S/merged-praxis
: > $S/git-shim.log; : > $S/lmstudio-guard-inv.log; rm -f $S/net-guard-inv.log
(cd "$MP" && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY PATH="$S/git-shim:$PATH" LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-inv.log NET_GUARD_LOG=$S/net-guard-inv.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs" \
  npm test -- tests/webhook_routes_inventory.test.ts > $S/praxis-inventory-merged.txt 2>&1; echo "exit $?" >> $S/praxis-inventory-merged.txt)
grep -E "^✔|^✖|^ℹ (tests|pass|fail)|^exit" $S/praxis-inventory-merged.txt | sed 's/ ([0-9.]*ms)$//'
echo "git shim log:"; cat $S/git-shim.log
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-inv.log | tr -d ' ') net=$(cat $S/net-guard-inv.log 2>/dev/null | wc -l | tr -d ' ')"
