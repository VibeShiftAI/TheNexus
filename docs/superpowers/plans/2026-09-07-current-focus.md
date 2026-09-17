# Current Focus Implementation Plan

**Goal:** Evolve CREW into the approved project-grouped activity panel.
**Architecture:** Pure signal derivation plus an existing-style HUD component; shared board/dispatch/HITL/progress data, with a safe usage-wait projection added to the existing proxy.
**Tech stack:** React, TypeScript, Next.js, Express, node:test and Jest.

- [x] Add focused failing tests for safe usage-wait projection, task/project grouping, running vs waiting vs board-only state, deduplication, missing attribution and freshness.
- [x] Implement `server/services/focus-usage-waits.js` and enrich `/dispatch-state` in `server/routes/praxis-stream.js`; projection failures stay explicit.
- [x] Implement `dashboard/src/lib/current-focus.ts` as a pure derivation over existing schemas. Precedence is live runtime, explicit waiting/input, then board-only fallback. Exact task/session matching only.
- [x] Add `dashboard/src/hooks/use-current-focus.ts`, sharing board/dispatch subscriptions and consuming existing HITL requests; expose snapshot receipt times and errors without adding polling loops.
- [x] Implement `dashboard/src/components/bridge/current-focus.tsx` with focused interaction tests. Replace only CREW's chip configuration in `status-strip.tsx`; retain grid and all other chips.
- [x] Run focused behavioral tests and TypeScript; request one independent scoped review, fix actionable findings, and run an isolated dashboard build.
- [x] Integrate only feature patches into the shared checkout, preserving unrelated working/staged changes. Activate the API change only after checking live task/chat/council/background activity. Verify live pip/panel and read-only endpoints; record evidence in the existing 90-day workstream and complete the existing Nexus task.

No duplicate execution worker. One natural delivery observation; test cases are not delivery observations and unexposed token totals remain unknown.
