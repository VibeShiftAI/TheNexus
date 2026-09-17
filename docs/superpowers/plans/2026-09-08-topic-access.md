# Topic access animation implementation plan

> Use superpowers:executing-plans to implement and verify these steps in the authorized live workspace.

**Goal:** Illuminate only knowledge communities actually accessed, keep the graph stationary, and restore gentle moving bridge dots.

**Architecture:** Read Cortex's existing `Entity.last_retrieved_at` stamps through an authenticated, fixed read-only Cypher query. Resolve current `IN_COMMUNITY` membership, expose bounded recent topic records through the existing cached knowledge-activity snapshot, and consume them through the shared provider. Require an exact fingerprint of the displayed community title, size, and ordered top entities as well as timestamp compatibility, so reused IDs cannot point to another displayed topic. No retrieval producer, ledger schema, or orchestration changes are needed.

**Rendering:** Fixed geometry and colors for the existing crystals. Recent access increases only the touched crystal's core/facet brightness with a smooth fade; no expanding wave, orbit rotation, or panel-wide glow. Slow, small dots drift along existing bridges whenever visible; stronger dots only between two accessed communities. Respect reduced motion and suspend offscreen/hidden work. Topics outside the fixed visible subset remain clickable through the activity report.

- [x] Add failing service, route, freshness/attribution, and canvas geometry/motion regression tests.
- [x] Implement bounded topic telemetry and wire it through the shared provider and Science detail links.
- [x] Replace network-wide effects with fixed-size local illumination and restore bridge particles.
- [x] Run focused tests, dashboard suite/build, independent review, and live read-only retrieval/browser checks; verify stable panel and canvas dimensions.

**Files:** `server/services/topic-access.js`, `server/routes/knowledge-activity.js`, their Jest tests; `dashboard/src/lib/{bridge-activity,topic-activity}.ts`, `dashboard/src/components/bridge/{knowledge-station,topic-constellation}.tsx`, and related node:test tests.

## Verification

- Read-only live query against Cortex retrieval stamps completed in ~238 ms while idle. No new producer or ledger writes; no changes to Cortex/Praxis source.
- A real memory search completed in 5.9 s and returned existing graph retrieval stamps for 21 communities; the shared API included their current map identities and accessed entity names. Browser graph showed only the corresponding visible community IDs and cleared them after the 12-second access window.
- Live before/during/after geometry was identical: Science panel 709 × 439, canvas 673 × 288, Ops panel 709 × 515; all x/y positions identical as well. The expanding rings, global canvas wash, rotating orbit silhouettes, and Science module-live glow were removed.
- Verified the access-record button opens Memory Access, a topic record opens Knowledge Activity Detail, and its report link includes the retrieved entity and knowledge-explorer anchor. Followed that link in a temporary browser tab: the full explorer loaded 44 nodes and 50 links, related topics, and expandable semantic context. Closed the temporary tab afterwards.
- 8 focused server tests passed. Dashboard suite: 366 tests passed. Isolated production build passed with NEXT_DIST_DIR=.next-topic-verify. Logs: /tmp/nexus-topic-tests.log and /tmp/nexus-topic-build.log.
- Independent review identified the ID reuse race. Added exact map identity matching and regression tests for both snapshot arrival orders; reviewer independently reran the focused suites and confirmed no remaining blockers.
