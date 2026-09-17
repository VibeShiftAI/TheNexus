# Praxis mailbox implementation plan

**Goal:** Open a dedicated, useful Praxis Inbox/Outbox from the dashboard COMMS pip.

**Architecture:** A read-only Praxis IMAP/draft API, a Nexus API proxy, and one dashboard page. The API contract is in the adjacent spec; backend and frontend can be implemented independently against it.

**Tech stack:** TypeScript, ImapFlow/mailparser, Express, Next.js/React, existing node:test/jsdom harnesses.

- [ ] Backend in `/Volumes/Projects/continuity-worktrees/Praxis-mailbox`: add focused failing tests, implement a mailbox service with injectable transport, connect read-only routes in `src/routes/comms.ts`, verify dedicated account isolation/read-only operations/cursors/errors/draft statuses. No live writes or restart.
- [ ] Frontend in this worktree: add API types/client in `dashboard/src/lib/nexus/mailbox.ts`, a focused React interaction test, and `/mail` list/detail UI with Inbox, Outbox Pending/Sent, full plain-text body and existing approval-card link. Failed loads remain explicit. Exclude remote image/HTML rendering.
- [ ] Link COMMS pip to `/mail`; move access to existing Feedback activity into the mail page. Add read-only proxies under `/api/praxis/mailbox` in `server/routes/praxis-stream.js` with validation delegated to Praxis.
- [ ] Run the focused backend, API proxy, and frontend tests; typecheck/build the changed surfaces. Review the feature once, fixing only actionable findings and rerunning affected checks.
- [ ] Integrate only feature-owned diffs into current checkouts, preserving unrelated work. Activate through the established supervisors only at a safe point. Verify actual existing Inbox/Sent mail and navigation without sending a new email.
- [ ] Record completed scope, checks, live evidence, and remaining inquiry-routing work in the existing 90-day plan and Nexus. Mailbox visibility alone is not website inquiry ingestion.

## Clarified feedback scope

Robert confirmed that feedback requests and responses belong in this Inbox and chose one combined list with filters. Extend the same service with feedback conversations and All-source pagination, show All/Email/Feedback filters with a full thread reader, and retire the old modal entry. Verify mixed pagination, stored questionnaire answers, draft state, linked tasks and live historical conversations. Reopen the same Nexus task until this clarified scope is live.
