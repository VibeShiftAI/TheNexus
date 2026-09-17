# Isolated document review browser check

Adapted from the prior repair's `/tmp/nexus-ui-iso/verify.mjs`, `api.js` and `receiver.js`. The check drives Chrome at 390px and 1440px: a visible whole-document note, saving/resuming the draft, Finish during an outage, and automatic delivery recovery without reload. The API fixture mounts the real document router and outbox against a new temporary database. A local stand-in receives every synthetic turn. The report is copied unchanged into the fixture project. Production databases and chat are never used.

**macOS setup:** temporary paths under `/var` resolve to `/private/var`. Document registration needs the report path and project root in the same canonical form; mixing the two can fail the path-boundary check. The fixture already uses `fs.realpathSync.native()` for both. Preserve those calls when adapting it.

Requires Node with global WebSocket (Node 22+), installed Nexus/dashboard dependencies and Chrome or Chromium in `/Applications`. Ports 3100, 4100 and 4199 must be free. From the repository root:

```sh
export NEXUS_REVIEW_QA_DIR="$(mktemp -d -t nexus-document-review-qa)"
node scripts/document-review-qa/api.cjs
```

Keep that API process running. In another terminal, from `dashboard/`, start the isolated dashboard:

```sh
NEXT_PUBLIC_API_URL=http://127.0.0.1:4100 NEXT_DIST_DIR=.next-document-review-qa npm run dev -- --port 3100
```

In a third terminal, use the same `NEXUS_REVIEW_QA_DIR` value and run from the repository root:

```sh
node scripts/document-review-qa/verify.mjs
```

The script starts/stops its own receiver on 4199 and Chrome. Stop only the two isolated API/dashboard processes afterward. Next may add `.next-document-review-qa/types/**/*.ts` and `.next-document-review-qa/dev/types/**/*.ts` to `dashboard/tsconfig.json`; remove only those newly generated entries while preserving all prior bytes/other edits. No production process needs a restart for this check.

Screenshots are saved under `$NEXUS_REVIEW_QA_DIR/shots/`. Keep stdout as the run log. `API_CALLS_SINCE_FINISH` counts parsed URL pathnames, including requests with `_cb` parameters, and asserts a Finish plus at least one submission poll. `DELIVERED_WITHOUT_RELOAD` must be true. The other printed phone hit-test/save observations and screenshots are visual evidence to inspect, not a replacement for the receiver storage-failure tests (`cd ../Praxis && npm test -- chat_idempotency`). The reusable stand-in is deliberately not a production durable receiver.
