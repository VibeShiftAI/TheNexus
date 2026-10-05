# Document links open the latest registered revision (task b07f64ad, 2026-10-04)

## Symptom

Robert finished a review of the vitality memo (document
`b27b40ae-f697-4ef4-913d-a84fb1184484`). The change he asked for was then
registered as revision `52c13935` (hash `512d84fa`). Opening the memo from
"Ready for your review" or from its task still showed the revision he had
reviewed.

## Cause

Both entry points render `DeliverableRow`, which links `/documents/<id>`
(`documentHref`). The API was correct: `GET /api/documents/<id>` (read with
`cache: no-store`) returned the current revision and content. It also returned
the reader's latest review, which was pinned to the reviewed revision
(`d3d4889c`, hash `a96cfef1`) with `document_changed: true`.
`DocumentReviewPage.load()` then always called `setViewRevision("pinned")`, so
the page rendered `review.pinned_content` and the header named the reviewed
revision. Because every open and every return navigation remounts the page and
calls `load()`, the old bytes came back each time. `ensureReview` and
`startNewReview` had the same automatic switch.

## Change

- `dashboard/src/components/document-review/document-review.tsx`: the page
  always opens on the latest revision; the automatic switch to the pinned view
  is gone from `load()`, `ensureReview` and `startNewReview`. A change of
  document id resets the view to the latest. The reviewed revision is still one
  explicit click away ("View reviewed revision"), read-only for decisions as
  before, and the banner now names both revisions.
- Unchanged on purpose: comments keep their original line numbers and quotes
  and are never re-anchored (moved or orphaned passages are labelled, as
  before); the decision card still sends the `revision_id` and `content_hash`
  of the revision on screen; the server's `409 stale_revision` guard and
  operator authority checks are untouched; no server code changed.
- `docs/contracts/document-review-deliverables.md` section 9 records the rule.

## Evidence

- Regression test `dashboard/src/components/__tests__/document-latest-revision.test.mjs`:
  4 of 4 fail on the old code, 4 of 4 pass after the change.
- `dashboard/scripts/latest-revision-browser-check.mjs` on an isolated stack:
  22 failures on the pre-change build (the page stays on the reviewed rev
  `0e6fdb4b` while the API's current revision moves through revs 2, 3 and 4)
  and 47 of 47 checks passing on this change. Details are in
  `2026-10-04-latest-revision-navigation-browser-check.json`.
- Read-only check on the live :3000 with the real memo, opened from task
  `e18c00e2`: the page shows rev `512d84fa`, matching the API, before and after
  back and forward; no non-GET request was made.

## QA repair (round 1)

QA found that `dashboard/scripts/decision-session-browser-check.mjs` (task
a1cc8616) still clicked "View current file" unconditionally after the
file-changed reload. Under the new default the page already shows the current
file, so that button is absent. Reproduced on an isolated stack (API 4399,
Praxis receiver 4398, `next start` 3399 on a fresh `.next-b07f64ad` build):
the only failure was `06-file-changed: button "View current file"`. Line 257
now calls the script's existing `viewCurrentFile()` helper, which clicks only
when the decision card is blocked; nothing else in that file changed. After
the change, all steps of that check pass with 0 failures. On the same build,
`latest-revision-browser-check.mjs` passes 47 of 47.

A fifth regression test rerenders the mounted page with another `documentId`
while the reviewed revision is selected, and expects the latest revision.
With the reset line removed from a scratch copy it fails on that assertion;
with the change, 5 of 5 pass, and the dashboard suite passes 801 of 801.

## Follow-up (after the pass)

The second document in that test now has its own ids, hashes, review and
bytes (`doc-2`, revs `d2-rev-1`/`d2-rev-2`). With doc-2 requests routed to
doc-1's server in a scratch copy, the test fails, so reusing the first
document's response is caught. A fresh run on the current working tree
(which also holds task a2553798's uncommitted server and db changes; this task
changed no server code) gave the following results:

- dashboard: 801 of 801 tests pass, and tsc is clean;
- `npx jest server/__tests__/document server/__tests__/documents-route`: 64 of
  64 pass;
- a fresh isolated build: `decision-session-browser-check.mjs` passes every
  step, including the refused-credential steps 03, 04 and 09 and decisions
  recorded on the current revision in steps 07 and 08;
- on the same build, `latest-revision-browser-check.mjs` passes 47 of 47.
