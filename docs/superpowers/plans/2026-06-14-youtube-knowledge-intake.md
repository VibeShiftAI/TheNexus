# YouTube Knowledge Intake Implementation Plan

> **Status: ✅ SHIPPED — verified against the codebase 2026-07-02.** The unchecked boxes below were never ticked during execution and are NOT open work. Canonical open-items list: shared-mind vault → `projects/Open Items Board.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept friendly YouTube channel/video inputs from The Nexus and enqueue Cortex ingestion for the five newest channel videos or one explicit video.

**Architecture:** Praxis implements YouTube resolution, transcript discovery, and ingestion queueing. The Nexus adds client/proxy helpers plus UI controls that call the Praxis-backed endpoints. Existing `runKnowledgeIntakeSweep` remains the single queueing path.

**Tech Stack:** TypeScript, Express, Node test runner, Next.js client components, existing `youtube-transcript` package.

---

### Task 1: Praxis YouTube Discovery API

**Files:**
- Modify: `/Volumes/Projects/Praxis/src/ingestion/discovery/youtube.ts`
- Test: `/Volumes/Projects/Praxis/tests/youtube_discovery.test.ts`

- [ ] Write failing tests for exporting single-video discovery and honoring a five-item channel cap.
- [ ] Run `npm test` equivalent with `npx tsx --test tests/youtube_discovery.test.ts` and confirm failure.
- [ ] Export `discoverYouTubeVideo`, keep `discoverYouTube` on the same `DiscoveredItem` shape, and raise the hard ceiling to five.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Praxis Queue Entrypoints

**Files:**
- Modify: `/Volumes/Projects/Praxis/src/ingestion/sweep.ts`
- Modify: `/Volumes/Projects/Praxis/src/ingestion/control-api.ts`
- Test: `/Volumes/Projects/Praxis/tests/youtube_intake_api.test.ts`

- [ ] Write failing tests proving a YouTube source add triggers a one-source five-video sweep and a single-video endpoint queues one item.
- [ ] Run `npx tsx --test tests/youtube_intake_api.test.ts` and confirm failure.
- [ ] Add a reusable `runKnowledgeIntakeForItems` helper, `runKnowledgeIntakeForSources`, and wire `/ingestion/youtube/video`.
- [ ] Update `/ingestion/sources` so successful YouTube additions call `runKnowledgeIntakeForSources` for that source with `maxItems=5`.
- [ ] Re-run focused tests.

### Task 3: Nexus Proxy And UI

**Files:**
- Modify: `/Volumes/Projects/TheNexus/server/routes/ingestion-control.js`
- Modify: `/Volumes/Projects/TheNexus/dashboard/src/lib/ingestion-control.ts`
- Modify: `/Volumes/Projects/TheNexus/dashboard/src/app/knowledge-ingestion/page.tsx`

- [ ] Add a proxy route for `POST /api/ingestion-control/youtube/video`.
- [ ] Add an `ingestYouTubeVideo` client helper.
- [ ] Add a single-video panel to Knowledge Ingestion and clarify the YouTube channel placeholder.
- [ ] Run available type/test checks.

### Task 4: Verification

**Files:**
- No new production files.

- [ ] Run focused Praxis tests for source registry, YouTube discovery, and intake API.
- [ ] Run The Nexus checks available in the workspace.
- [ ] Inspect git diffs in both repos and confirm no unrelated dirty files were modified.
