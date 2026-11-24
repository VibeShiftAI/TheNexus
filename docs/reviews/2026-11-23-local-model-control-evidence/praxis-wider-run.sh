#!/bin/bash
# The wider Praxis regression run for round 4: every suite that imports the LLM
# manager, the local model state or the output-room wrapper and is not already in
# the related set (praxis-manager-importers.txt), except
# maintenance_review_regressions, which makes its data dir under
# /Volumes/Projects/maintenance-mode-worktrees rather than in a temp dir.
# Guards: the LM Studio guard, the network guard, the live-port guard (every port
# listening before the run, and every host off this machine), the fake lms, and
# shims for the claude, codex and agy CLIs and the audio and dialog tools.
S=/Volumes/Projects/.scratch-fa032fc0
P=${PRAXIS_DIR:-/Volumes/Projects/.praxis-worktrees/fa032fc0-7472-4406-b6cb-d4671b72a28a/Praxis}
TAG=${TAG:-wider-r4}
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un > $S/live-ports-$TAG.txt
echo "live ports at start: $(wc -l < $S/live-ports-$TAG.txt | tr -d ' ')"
# Self-test of the live-port guard: a listening live port is refused, a fresh server is reached.
: > $S/live-port-guard-selftest.log
LIVE_PORTS_FILE=$S/live-ports-$TAG.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-selftest.log node --import=file://$S/live-port-guard.mjs -e '
const http = require("node:http");
const s = http.createServer((q, r) => r.end("own")).listen(0, "127.0.0.1", async () => {
  const own = await fetch(`http://127.0.0.1:${s.address().port}/`).then((r) => r.text()).catch((e) => "refused " + e.cause?.code);
  const live = await fetch("http://127.0.0.1:4000/api/health").then((r) => "reached " + r.status).catch((e) => "refused " + (e.cause?.code || e.message));
  const off = await fetch("https://example.com/").then((r) => "reached " + r.status).catch((e) => "refused " + (e.cause?.code || e.message));
  console.log(`self-test: own server -> ${own}; live :4000 -> ${live}; off-machine -> ${off}`);
  s.close();
});'
echo "self-test guard log lines: $(wc -l < $S/live-port-guard-selftest.log | tr -d ' ')"
NAMES=$(grep -vx maintenance_review_regressions $S/praxis-manager-importers.txt | tr '\n' ' ')
FILES=$(for n in $NAMES; do printf 'tests/%s.test.ts ' "$n"; done)
echo "files: $(echo $FILES | wc -w | tr -d ' ')"
: > $S/lmstudio-guard-$TAG.log; : > $S/lms-calls.log; : > $S/live-port-guard-$TAG.log; : > $S/cli-shims.log; rm -f $S/net-guard-$TAG.log
(cd $P && env -u PRAXIS_DATA_DIR -u NODE_TEST_CONTEXT -u GOOGLE_API_KEY -u YOUTUBE_API_KEY LOCAL_LLM_URL=http://127.0.0.1:1/v1 \
  PATH="$S/cli-shims:$PATH" CLAUDE_CODE_BIN=$S/cli-shims/claude CODEX_BIN=$S/cli-shims/codex AGY_BIN=$S/cli-shims/agy \
  PRAXIS_LMS_BIN=$S/fake-lms LMSTUDIO_GUARD_LOG=$S/lmstudio-guard-$TAG.log NET_GUARD_LOG=$S/net-guard-$TAG.log \
  LIVE_PORTS_FILE=$S/live-ports-$TAG.txt LIVE_PORT_GUARD_LOG=$S/live-port-guard-$TAG.log \
  NODE_OPTIONS="--import=file://$S/lmstudio-guard.mjs --import=file://$S/net-guard.mjs --import=file://$S/live-port-guard.mjs" \
  npm test -- $FILES > $S/praxis-$TAG-run.txt 2>&1; echo "exit $?" >> $S/praxis-$TAG-run.txt)
grep -E "^ℹ (tests|suites|pass|fail|cancelled|skipped)|^exit" $S/praxis-$TAG-run.txt
grep -E "^✖ " $S/praxis-$TAG-run.txt | grep -v "failing tests" | sed 's/ ([0-9.]*ms)$//' | sort -u | head -30
echo "guards: lmstudio=$(wc -l < $S/lmstudio-guard-$TAG.log | tr -d ' ') fake-lms=$(wc -l < $S/lms-calls.log | tr -d ' ') net=$(cat $S/net-guard-$TAG.log 2>/dev/null | wc -l | tr -d ' ') live-port=$(wc -l < $S/live-port-guard-$TAG.log | tr -d ' ') cli-shims=$(wc -l < $S/cli-shims.log | tr -d ' ')"
