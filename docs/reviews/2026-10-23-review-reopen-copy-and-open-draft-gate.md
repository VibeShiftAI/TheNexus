# Review-reopen copy and the open-draft gate (task 9f4477b5)

QA follow-up of task 6b46dcc8 (one current document version, superseded review
requests). QA baseline `a359d83c10ef`. Evidence files are in
[2026-10-23-review-reopen-copy-and-open-draft-gate/](2026-10-23-review-reopen-copy-and-open-draft-gate/).

## Dispositions

### Suggestion 1 (reviewer): qualify the in-progress reopen copy: implemented

Every explanation shown while replacement work is open used to say the version
reopens when "the work fails or is cancelled". That holds only when the attempt
registered no result **and no failed result governs the current version**. An
attempt that registered bytes and then failed or was cancelled leaves those
bytes current and closed (`replacement_failed`) until an explicit recovery
delivers (contract 12.5). And when the open work is itself a recovery over such
bytes, its failure before registering anything leaves them closed too: the
earlier attempt still governs them. Each site now says both (the second
condition was added in the QA repair round below):

| Surface | Location |
| --- | --- |
| 409 `replacement_in_progress` message (reviews, decisions, content) | `server/routes/documents.js:371` (`notReviewable`) |
| Router header, list-row comment, replacement-section comment | `server/routes/documents.js:47`, `:708`, `:1523` |
| Store comments on `LIST_STATUSES` and the replacement table | `db/document-reviews.js:87`, `:101` |
| Decision refusal after work was accepted meanwhile | `dashboard/src/components/document-review/decision-card.tsx:116` |
| Replacement note in the decision card | `decision-card.tsx:206` |
| Blocked-decision reason | `decision-card.tsx:296` |
| "No review can start" line in the reader | `dashboard/src/components/document-review/document-review.tsx:1183` |
| Reader banner for open work | `document-review.tsx:1461` |
| Being revised badge title for open work | `dashboard/src/components/document-review/deliverable-row.tsx:103` |
| Contract, failure without a result | `docs/contracts/document-review-deliverables.md`, 12.5 first bullet |

The failed-result copy was already correct and is unchanged.

## QA repair round (attempt 0): the failed result that governs an open recovery

**Finding (codex, criterion 2).** An attempt registers v2 and fails; a recovery
opens on base v2, then fails before registering anything. v2 stays closed with
`replacement_failed`, named by the first attempt (server test "a recovery that
fails before registering anything ...", `server/__tests__/document-replacements.test.js:655`).
The round-1 copy shown while that recovery was open still said "this version
reopens" if the work failed before registering bytes.

**Reproduced before any change.** A probe built from the suite harness, kept in
`/tmp` so the repo was untouched, opened that recovery and read the 409 text.
The round-1 message promised "this version reopens"; once the recovery failed
without bytes the code was `replacement_failed`
(`50-repro-probe-before.txt`: the `replacement_failed` assertion passed and the
qualified-copy assertion failed with the round-1 string).

**Fixed.** Every sentence that says when this version reopens after a failure
now reads "reopens only when no failed result governs the current version",
then names the closed cases: "if an earlier failed or cancelled attempt
registered this version, or the work registered bytes first, review waits for
an explicit recovery". That covers the 409 message (`server/routes/documents.js:371`),
the router header and the list-row and replacement-section comments
(`documents.js:47`, `:708`, `:1523`), the store comments
(`db/document-reviews.js:91`, `:104`), the decision card (`decision-card.tsx:116`,
`:206`, `:296`), the reader (`document-review.tsx:1183`, `:1461`), the Being
revised badge (`deliverable-row.tsx:103`) and contract 12.5. The copy is
static: the UI cannot tell from the open item whether its base is a failed
result, so every surface states the condition. No lifecycle code changed, and
the open-draft gate (`documents.js:1888`) is untouched.

**Assertions cover the open recovery.**

- Server: the failed-recovery test now posts a review while the recovery is
  open. It asserts 409 `replacement_in_progress` naming attempt 2 and the
  qualified message, then lets the recovery fail and keeps the existing
  `replacement_failed` assertions (`document-replacements.test.js:666-669`;
  the shared pattern is `QUALIFIED_IN_PROGRESS` at `:116`).
- Dashboard: a new test renders an open recovery (attempt 2,
  `recovers_replacement_id: 'rp-1'`, base `rev-2`). It requires every
  reopening sentence on the banner, blocked decision, replacement note and
  review-closed line to carry both qualifications (`assertGovernedReopen`),
  and forbids an unconditional "this version reopens". It then remounts after
  the recovery has failed, and v2 shows the failed-result closure with no
  "Start a new review" (`dashboard/src/components/__tests__/document-replacements.test.mjs`,
  "an open recovery over an earlier failed result ..."). The three round-1
  copy tests use the new text, and the badge test asserts the row's
  `attempt 2`.

| Evidence | Result |
| --- | --- |
| `50-repro-probe-before.txt` | reviewer's case reproduced on the round-1 tree: closed afterwards, copy promised reopening |
| `51-round1-new-server-tests.txt` | this round's server test on round-1 code (git archive 2bdd74e): 2 failed, the round-1 message received |
| `52-round1-new-dashboard-tests.txt` | this round's dashboard test on round-1 code: 4 failed, the round-1 copy as `actual` |
| `60-after-server-replacements.txt` | 15/15 |
| `61-after-server-same-five-suites.txt` | 70/70 (like-for-like with `12-`; assertions were added inside existing tests) |
| `62-after-server-six-suites.txt` | 133/133 |
| `63-after-repro-probe.txt` | the probe from `50-` passes |
| `70-after-dashboard-replacements.txt` | 13/13 (one new test) |
| `71-after-dashboard-document-tests.txt` | 112/112 (111 in `21-` plus the new test) |
| `72-after-dashboard-typecheck.txt` | `tsc --noEmit` exit 0 |
| `80-encoding-scan.txt` | strict UTF-8 and mojibake scan of the files edited this round, exit 0 |

### Suggestion 2 (adversarial critic): POST /:id/reviews returned an existing draft without the gate: implemented, one part stands with evidence

The critic's code reading was right. Before the change the reviewability gate
ran only when no draft existed, so an existing draft was handed back writable
without it.

**Fixed.** The gate now runs before the draft lookup, so a closed version
answers 409 (`replacement_in_progress`, `replacement_failed`,
`revision_not_ready`) whether or not the caller has a draft
(`server/routes/documents.js:1888`, before `findOpenDraft` at `:1894`). On the
baseline, a draft that bypassed acceptance came back with 200 and
`status: "draft"` while work was open (`31-baseline-open-draft-gate.txt`). After
the change it gets 409 `replacement_in_progress`, and 409 `replacement_failed`
once the attempt fails with its result current (test at
`server/__tests__/document-replacements.test.js:738`).

**The reviewer's pass stands on reachability.** Through the API, no draft
survives into open or failed work. Acceptance supersedes every open draft on the
document, including one pinned to an older revision. The same test shows
`superseded_reviews` naming the v1 draft and `findOpenDraft` returning nothing.
Inserts are gated inside the transaction. The fix makes the route correct on
its own instead of depending on that invariant.

**"Labelled with the current revision's metadata": declined, with evidence.**
`reviewView(review, { revision })` uses the current revision only to compute
`document_changed` and the comment anchors. The response keeps the draft's own
`revision_id` and `pinned_revision`, and sets `is_current_revision: false` and
`document_changed: true`. Outside replacement work, a plain capture can move the
document past a draft. That draft is still returned (200, `created: false`),
pinned to v1, with or without `revision_id: v2`. This is the established
preserve-drafts behaviour: the reader annotates the pinned version
(`document-review.tsx:442`, `canAnnotate`), and parent criterion 1 forbids
destroying drafts. Finishing that round gives no authority on v2. Acceptance
citing it is 409 `source_not_current` (`authority_revision_id` = v2), a v1
decision is 409 `stale_revision`, and nothing is recorded (test at
`document-replacements.test.js:781`). A new round only ever opens on the current
revision. The route header (`documents.js:23`) and contract 12.4
(`docs/contracts/document-review-deliverables.md:808`) now say this.

## Verification

| Evidence | Result |
| --- | --- |
| `01-before-server-document-suites.txt` / `12-after-server-same-five-suites.txt` | 68/68 before, 70/70 after (two new tests) |
| `11-after-server-document-suites.txt` (adds document-outgoing) | 6 suites, 133/133 |
| `02-before-dashboard-document-tests.txt` / `21-after-dashboard-document-tests.txt` | 108/108 before, 111/111 after (three new tests) |
| `22-after-dashboard-typecheck.txt` | `tsc --noEmit` exit 0 |
| `30-baseline-new-server-tests.txt` | new server test fails on baseline: old message received |
| `31-baseline-open-draft-gate.txt` | baseline returns 200 with the draft where 409 is expected |
| `32-baseline-new-dashboard-tests.txt` | 3 new dashboard tests fail on baseline, the old copy shown as `actual` |

Baseline runs use `git archive a359d83c10ef` into `/tmp/nexus-9f44-baseline`
(node_modules symlinked, new test files copied in). The shared tree was not
checked out.

## Not covered and follow-ups (not filed)

- An existing draft on a visual revision that is `revision_not_ready` now gets
  409 from `POST .../reviews` instead of 200. This comes from the code
  (`documents.js:1888-1889`), not from a test, because the suites have no
  fixture for a not-ready revision. The reader already blocks annotation when
  not reviewable, and it reads the draft from `GET /:id`, so its flow is
  unchanged.
- Draft write routes (summary, comments, finish) still rely on supersession and
  check status only (`requireDraft`, `documents.js:680`), as contract 12.4
  specifies.
- `closedByVersion` in `document-review.tsx:148` omits `replacement_failed`. A
  stale tab whose version closed by a failed result within the 15 s poll gets a
  plain error instead of a reload, and on "Start a new review" a load error.
