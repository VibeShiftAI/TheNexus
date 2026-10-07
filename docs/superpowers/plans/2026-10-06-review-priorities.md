# Review priorities implementation plan

**Goal:** Surface work waiting on document reviews and recover misclassified drafts.
**Architecture:** Add explicit document waiting-task IDs, derive active blockers from
SQLite task state and exact-revision review status, and reuse this projection in
list ordering, task filters, and the shared row/reader components.
**Tech Stack:** SQLite, Express, Next.js, React, Jest and Node test runner.

- [x] Add failing API tests in server/__tests__/document-deliverables.test.js for
  validated blocking_task_ids, request-review, terminal-task exclusion, approval /
  changed revision behavior, task filtering and ordering before pagination.
  Run `npx jest server/__tests__/document-deliverables.test.js --runInBand`.
- [x] Extend db/document-reviews.js with the additive JSON column and SQL count /
  task projection; extend server/routes/documents.js with validated declarations
  and an idempotent request-review route. Keep the producer association intact.
- [x] Test and implement dashboard shared blocking-task links and reader review
  requirement editing, using existing session fetch and task URLs. Run the affected
  Node component/client suites and the complete document API suites.
- [x] Inspect all 15 reference records, reviews, successors and linked task states;
  apply only justified promotions through the store, retaining an exact before /
  after audit. Record confirmed waiting-task relationships only.
- [x] Build with NEXT_DIST_DIR=.next-verify-review-priorities; restore only the
  generated tsconfig entry. Review the task diff against the initial worktree
  snapshot, activate through the supervised API, and verify live UI/API behavior.
