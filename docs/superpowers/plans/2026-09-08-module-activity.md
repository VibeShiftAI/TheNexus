# Module Activity Implementation Plan

> Execute inline with superpowers:executing-plans. The user has authorized redesigning the existing modules and removing the standalone activity row once their signals are covered. Preserve unrelated staged work and the live supervised dev server.

**Goal:** Make activity visible within each existing dashboard module, using the main viewer's presence as the visual reference.
**Architecture:** Keep the shared BridgeActivityProvider and its freshness/reconciliation rules. Use a single dispatch topology with HTML controls over SVG connections; extract the knowledge canvas into its own component with detailed faceted nodes. Reuse existing report routes and modals. No additional telemetry pollers for activity decoration.
**Tech Stack:** React 19, Next 16, TypeScript, SVG, Canvas 2D, CSS; node:test/jsdom.

## Acceptance criteria
1. Ops has one graphic incorporating council participation, executor work/QA, local model, memory headroom, lane occupancy and queue. Native keyboard controls open executor/council/capacity details. Concurrent roles remain visible; stale telemetry cannot appear live.
2. Science's topic nodes have visible internal structure at close range. Real memory and vault events illuminate the graph with distinct colors; clicks expose community details and activity evidence. Whole-network access is labeled honestly because the ledger does not identify the accessed topic.
3. The standalone Activity circuits row is removed after Tactical, Power, Inbox, Schedule, Recent Activity, Project Reference, and the existing Core each cover relevant activity. The shared report, master display size, mobile layout, and reduced-motion behavior remain usable. Dashboard tests and isolated production build pass, and browser inspection exercises main controls at desktop and narrow widths.

## Tasks
- [x] Add tests for active-item attribution, dispatch-map concurrent council/executor roles, stale signals, capacity and community drilldowns.
- [x] Extend the shared activity derivation with attributed active items; preserve the existing channels/report.
- [x] Replace the Ops CrewFlow + CLI list + memory bar with DispatchMap; reuse capacity detail and executor modal (including OpenRouter). Retain queue positions, suspension/stall visibility and arbiter controls.
- [x] Extract and enhance TopicConstellation: faceted cores, orbital filaments, actual activity illumination, zoom-correct hit testing, selected community details, memory/vault report controls within Science.
- [x] Enhance task rows with fresh execution and QA state, recent terminal results; light the existing Power reactor/source meters on token changes.
- [x] Add contextual activity effects to Inbox, Schedule, Recent Activity, Project Reference; retain Core presence. Remove the homepage ActivityMonitor row.
- [x] Verify focused tests, full dashboard suite, isolated build and live browser drilldowns at desktop/mobile widths. Review scoped diff, fix material findings, record results here.

## Visual and data rules
Quiet states retain restrained depth with no moving work packets. Execution cyan, council amber, review violet, success emerald, failure rose. No synthetic percent-complete or fabricated topic attribution. Missing/stale values remain unknown. Animations honor reduced motion and visibility; canvas animation pauses when outside viewport. Existing detailed raw policy prose stays behind the capacity report.

## Verification — 2026-09-08

- `npm test` in dashboard: **362 passed, 0 failed** (log: `/tmp/nexus-module-activity-tests.log`). Includes roster expansion, simultaneous council/execution, multi-round seat reconciliation, QA color/report semantics, stale run suppression, community navigation, initial-load arrival suppression, canvas hit testing at 200% scale, reduced motion and offscreen animation cleanup.
- `NEXT_DIST_DIR=.next-module-verify npm run build`: **passed** (log: `/tmp/nexus-module-build.log`). Restored only the generated verification-directory includes in tsconfig; the live dev output stayed separate.
- Browser: desktop Ops and Science inspected; temporary isolated fixtures exercised simultaneous executor, QA, council, memory access and violet vault-write activity; fixture route removed. Expanded community selection followed to a full knowledge report with its entity query prefilled and results displayed. Science vault activity opened a document-specific report link. At 390px viewport the full roster and capacity report fit without horizontal clipping. Master scale retained; canvas hit testing tested at 200%.
- Independent review found six material issues (council/schedule stale display, missing executor report links, Science offline access, round-two duplicate seats, QA completion color); each was fixed. No orchestration settings were changed.

Access visualization illuminates the whole network: the MCP/file telemetry does not identify a specific accessed community. Council roles come from the configured default bench when idle and actual session voices when active. Executor nodes follow the runtime roster, including additional names.
