# Approved-plan follow-ups implementation plan

**Goal:** Show only unscheduled successors of today's approved calendar work.
**Architecture:** Reuse the slate reader and add a pure graph-scope helper in server/services/approved-plan-followups.js. Pass that scope to the existing live-work projection. Preserve actual execution lanes and all authorization mechanisms. Surface root lineage in the shared automatic-start component.
**Tech Stack:** CommonJS/Express, SQLite, Jest, TypeScript/React.

- [x] Add failing helper and route tests for approved/pending/rejected/missing/old plans; linked and unrelated successors; completed parents/intermediates; duplicates; already-scheduled tasks; missing calendar evidence; read failures; active runtime preservation.
- [x] Implement buildApprovedPlanFollowupScope(slate, events, rows, now) returning a map from eligible task IDs to approved root references. Gate on today's explicit approval and intersect approved slots with today's calendar. Walk dependency and successor edges to a fixed point; prevent cycles and omit terminal/archived tasks and scheduled descendants.
- [x] In GET /live-work, read the slate via readSlateLifecycle and calendar rows read-only. Pass scope as the third projectLiveWork argument. No scope changes to execution state or automatic-start storage.
- [x] Add followsToday references to the live-work type and render them in AutomaticStartControl, shared by Home and Calendar.
- [x] Run Jest live-work/scope/proxy regressions, dashboard component checks and TypeScript. Independently review changes, activate only Nexus if safe, and verify the live endpoint. Preserve unrelated shared edits; do not commit them.

Validation: 41 scoped server tests and 28 dashboard component/merge tests passed. Independent review found historical failed runs masking eligible successors; fixed with a regression test while retaining active QA precedence. Full dashboard typecheck reports two errors in unrelated Groundrules labeling files (stage-b-form.tsx:67, workbench.tsx:245); no errors in changed files.
