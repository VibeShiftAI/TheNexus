# Review priorities — verification and reconciliation

Implemented October 6, 2026, following Robert's approved design in this chat.

## Delivered

Explicit waiting-task IDs separate from the producer, derived blocker badges with
same-origin task links, blocking-count ordering before pagination, cross-project
discoverability, and a searchable reader control for review requirements/reference
promotion. Registration accepts the optional IDs; the API validates existence.
Current-revision approval or terminal/archived task state removes a blocker.
This is a cockpit projection, not a change to dispatch or task state.

## Legacy reconciliation

Promoted in place via the live request-review API:

- `282926af-f480-4969-b653-0b0e05d304a1`: current introduction/Chapter 1 draft.
  Metadata and the project's program of record identify outstanding editorial
  review. Its draft feedback remains intact, including all 16 comments.
- `01be14ff-c054-40be-8a92-272167d5fc3d`: Elizabeth's unsent Meeple update.
  The document explicitly awaits Robert's document review. Promotion does not
  reinstate the cancelled sending card or authorize sending.

The other 13 references remain references: old reviewed/replaced outlines, their
private evidence companion, the already-approved outline, source email, completed
implementation slate/consumer contract, and informational recovery reports. The
contract's old metadata-level requires_review flag is historical; its implementation
and consumer tasks are completed, so it was not automatically re-opened.

Counts changed from 5 pending / 15 reference to 7 pending / 13 reference; all 25
records and all existing decisions/reviews/registrations were retained. Both
promotions also retained their existing current revision. Exact before/after rows
and history counts are in `2026-10-06-review-reference-reconciliation.json`.

No waiting-task IDs were invented during cleanup. Completed producer tasks do not
establish a current review dependency. The consulting project's pending checkpoint
is recorded as missing independent verification; that alone is not evidence of an
editorial-approval dependency. The publishing hold names the separate qa-gate draft,
not the introduction draft. The new picker and producer declaration support recording
confirmed consumer-task relationships without conflating these different gates.

## Evidence

- Six document API suites: 103 tests pass. New tests were observed failing before
  implementation and cover pagination priority, duplicates, cross-project filters,
  idea tasks, terminal/archive/delete lifecycle, exact-revision approval, promotion,
  missing IDs, invalid values and cross-site refusal.
- Six dashboard component/client suites: 64 tests pass, including linked badges in
  compact/full rows, reference promotion, preserved selection on save failure, and
  existing queue, decisions, task/project panels and bridge behavior.
- Dashboard production build passes with isolated `.next-verify-review-priorities`.
  Removed only the generated verification-dist entries from tsconfig afterwards.
- Independent code review found cross-project filtering and idea-stage omission;
  both fixed with a regression test; reviewer confirmed the fixes.
- Restarted only the supervised Nexus API child; supervisor restarted it successfully.
  Live review-task-options returned 64 eligible task options.
- Browser verified seven pending documents, both promoted drafts, Chapter 1's
  comments and editable review controls, and task search. Picker cancelled without
  adding unverified associations. Review queue left open.
- `git diff --check` passes. Existing unrelated local changes retained; no blanket
  commit or reset performed.
