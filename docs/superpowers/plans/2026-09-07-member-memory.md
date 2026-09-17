# Member Memory Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for implementation and independent review. Work only in the isolated sibling repositories under `/Volumes/Projects/member-memory-worktrees` until verification finishes.

**Goal:** Give Praxis and Robert a durable, evidence-backed member memory that supports scoped current facts, corrections, and commitments.

**Architecture:** A shared Zod contract; append-only SQLite ledger behind the existing Nexus member API; deterministic current projection; a stakeholder panel and a Praxis tool consuming the same contract.

**Tech stack:** TypeScript/Zod, Node/Express, better-sqlite3, React/Next, Jest and node:test.

- [x] Record baseline verification with temporary databases and isolated runtime data.
- [x] Add `nexus-shared/src/entities/member-memory.ts`, export from the entity barrel, validate incompatible fields/dates/transitions with contract tests, and build private consumer copies.
- [x] Add `TheNexus/db/member-memory.js`, initialize it after contact migrations, expose facade functions, preserve `/log` behavior with transactional durable writes, and extend `server/routes/contacts.js`. Write failing store/route regressions first, then pass all member-related tests.
- [x] Add `Praxis/src/tools/member-memory-tools.ts`, dedicated Nexus client methods, and registry composition. Write isolated request/response and bridge-scope tests before implementing. Preserve existing shared edits.
- [x] Add `TheNexus/dashboard/src/lib/nexus/member-memory.ts` and `components/member-memory.tsx`, mount in `project-stakeholders.tsx`, verify scoped reloads, safe errors, and form transitions with fixture tests and a real browser. Build without replacing live output.
- [x] Have fresh reviewers inspect specification compliance, then code quality, against baseline commits in `baseline.json`; repair findings and rerun affected checks.
- [x] Integrate only this pilot's patch into the shared source if it still applies cleanly; rebuild the contract and necessary consumers. Record exact validation, deployment state, and remaining roadmap in a review note. Do not restart active orchestration work blindly.

Tests use synthetic members and isolated SQLite files. No real member records, outreach, Cortex ingestion, or scheduled jobs are needed to validate this pilot. Existing unrelated workspace edits are snapshotted into the worktree baseline, not included in the pilot patch.

Completed and active September 7, 2026. Verification and remaining scope: `/Volumes/Projects/reviews/cortex-member-memory-pilot-2026-09-07.md`. 84 targeted/regression checks, builds/typecheck, independent reviews, migration rehearsal, and live API/tool/dashboard checks passed.
