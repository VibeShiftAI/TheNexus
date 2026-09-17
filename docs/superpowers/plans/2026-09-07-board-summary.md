# Compact board summaries implementation plan

> For agentic workers: use superpowers:subagent-driven-development with isolated source changes and independent review. Do not commit or deploy from an implementation subtask.

**Goal:** Reduce planning context from full board histories to bounded task pages while preserving dependency truth and complete evidence access.

**Architecture:** Add opt-in `GET /api/board-state?view=summary` with SQL field projection and stable keyset pagination; keep the existing full response unchanged. Praxis adds a typed summary reader and defaults only the interactive `nexus_board` state action to summaries. Internal callers requiring complete project/task metadata retain the full reader.

**Tech stack:** Express, SQLite/better-sqlite3, Jest; Praxis TypeScript and node:test.

## Contract

Query: `view=summary`, optional `project_id`, comma-separated canonical `status`, integer `limit` (default 50, maximum 100), opaque `cursor`.

```ts
interface BoardSummaryPage {
  view: "summary";
  tasks: Array<{
    id: string; project_id: string; project_name: string;
    title: string; status: string; priority: number;
    dependencies: string[]; is_unblocked: boolean;
    updated_at: string | null; version: number;
    detail: { href: string; has_description: boolean; has_payload: boolean; has_qa_evidence: boolean };
  }>;
  page: { limit: number; returned: number; total: number; has_more: boolean; next_cursor: string | null; sort: string };
}
```

Sort: priority descending, created_at ascending, id ascending. A cursor binds this ordering and project/status filters; reject malformed or mismatched cursors. This is a live traversal, with no atomic snapshot promise across concurrent edits. Fixed-cohort pages must be complete and disjoint. Resolve every returned task's dependencies using authoritative task statuses, including filtered/archived projects. `detail.href` is the existing full-task endpoint; never clip descriptions, QA reports, payloads or dependencies into invented evidence fragments.

## Tasks

- [ ] Server: add failing real-SQLite route tests in `server/__tests__/board-summary.test.js` for projection, filters, tied ordering, page exhaustion, invalid queries, external/missing dependencies, full response compatibility and a 50-task fixture below 64 KiB. Exercise complete task evidence through the existing endpoint.
- [ ] Implement a narrow DB projection helper and route validation in `db/index.js` (or a dedicated helper) and `server/routes/dashboard.js`. No SELECT-star/materialized-history trimming on the summary path. Surface data failures as failures, never empty success. Run `npx jest server/__tests__/board-summary.test.js server/__tests__/task-cas.test.js --runInBand`.
- [ ] Praxis: write `tests/board_summary.test.ts`, add a typed summary client at `src/nexus/board-summary.ts` and the client method in `src/nexus/client.ts`; change `src/antigravity/antigravity-tools.ts` schema and state handler to accept view/status/limit/cursor. The state tool defaults to summary, supports explicit full, returns pagination intact, and fails visibly without silently downloading full history. Full internal `nexusBoardState()` stays compatible.
- [ ] Verify client requests and discovery schemas, page envelope validation and full-task drill-down. Run focused node:test suites and TypeScript. Independently review both sides, integrate only baseline-matching scoped files, reload after checking active executions, measure live full versus summary bytes and inspect the live tool schema. Update existing Nexus C5 task and roadmap with evidence; leave changes uncommitted.
