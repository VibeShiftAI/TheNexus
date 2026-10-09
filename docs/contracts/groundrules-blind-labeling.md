# Groundrules blind labeling in Nexus: contract v1

Robert labels the Groundrules gold-set packet from the Nexus cockpit instead
of editing JSON by hand. The originating task
(`2617e7be-7026-454d-8705-7a37e04e0144`, project
`040c7a02-5665-4bff-9ddd-abe61abd7484`) carries a Start/Continue card ahead of
its source inventory; the card opens `/task/<id>/labeling`, a guided
one-passage-at-a-time workbench for the three stages the packet defines.
Every answer is stored on the server; the browser keeps nothing but the
per-tab operator credential.

Implementation: `server/routes/groundrules-labeling.js` (API),
`server/services/groundrules-labeling/{packet,validation,quotes,store,authority,export,links}.js`,
`dashboard/src/lib/groundrules-labeling.ts` (client and local quote
resolver), `dashboard/src/components/groundrules-labeling/*` (workbench and
forms), `dashboard/src/components/task-view/labeling-entry-panel.tsx` (task
page card), `dashboard/src/app/task/[id]/labeling/page.tsx` (route).

## Packet and linkage

1. **The packet is read from the Groundrules repo, never copied.**
   `GROUNDRULES_GOLD_DIR` (default
   `/Volumes/Projects/Groundrules.club/data/ledger/gold-set`) holds
   `packet/packet.json` and `roster.json`. The service re-reads them when
   their mtime or size changes and reports `sha256` of the packet bytes plus
   the packet's own `rosterSha256`, `guidelineSha256`, `controlsSha256`,
   `vpuSha256` and `thresholdsSha256`. No other path is ever read.
2. **Only linked tasks expose the interface.** `links.js` names the
   originating task; `GROUNDRULES_LABELING_TASK_IDS` can add ids without a
   code change. `GET /api/groundrules-labeling/tasks/:taskId` answers
   `{ linked: false }` for everything else and the task page shows no card.
   Related tasks (packet preparation `f70448bc…`, blind protocol
   `1d1fac51…`, later scoring `1d0feb38…`) are linked from the workbench,
   never duplicated.
3. **Roster anchors travel with the rows.** Each Stage A row carries its
   quotable contexts (`quote`, `sourceUnit` when the context lives in another
   unit, `quotable` when the roster lists it) and `anchorWithin` when the
   roster pins the row inside a wider span because the row text repeats in
   its unit. The validator and the export use the same anchors the scorer
   uses.

## Sessions, answers and stage gating

4. **One session per task and packet hash.** `POST /tasks/:taskId/session`
   creates the session bound to the packet `sha256` and digests on disk
   (201), or returns the existing one (200). A session whose packet no
   longer matches the disk answers `packet_changed` (409) instead of being
   silently re-bound.
5. **Stage content is served only when the API has unlocked it, and only
   after the operator's own reveal.** Stage A is in the session read.
   `GET /sessions/:id/stages/B` needs Stage A committed and `GET …/stages/C`
   needs Stage B committed; otherwise 403 `stage_locked`. A read never
   records exposure: an unlocked but unrevealed stage answers 403
   `stage_not_revealed` with no content. `POST /sessions/:id/reveal/:stage`
   (operator authority, `packet_sha256`) records `revealed_at` once (201 the
   first time, 200 with the same time after) and is the only way to open
   Part B or C; the dashboard shows a reveal gate and sends the reveal, then
   the read, only when the operator opens it, so the recorded exposure is a
   deliberate act by the person it is attributed to. Nothing from Part B or
   Part C is embedded in Stage A responses.
6. **Every save is validated, stored and acknowledged.**
   `PUT /sessions/:id/answers/:stage/:itemId` takes
   `{ packet_sha256, base_revision, state, answer }`. The server checks the
   shape (400 `malformed_answer`), the packet hash (400
   `packet_sha256_required`, 409 `packet_mismatch`, 409 `packet_changed`),
   the item (404 `unknown_item`) and the stage (403 `stage_locked`, 409
   `stage_committed`). Quotes are resolved with the scorer's anchor rule
   (whitespace-insensitive words, word boundaries, exactly one match in the
   row, the named context, or the row's `anchorWithin`); failures are
   per-field errors with a reason and count. The response carries the stored
   record, the new session revision and `saved_at`; the dashboard shows
   "Saved" only after that acknowledgment.
7. **Four answer states are distinct.** `untouched` (no record),
   `draft` (saved with open errors), `unsure` (saved with the explicit
   "return later" flag, whatever its content) and `complete` (saved with no
   errors). "No conditions, exceptions or negations" is an explicit
   `propositionsDeclared: "none"`, distinct from an untouched row; `UNKNOWN`
   is accepted for modality, verdicts and pair answers and counts as
   unanswered. Drafts and unsure answers always save and never count as
   complete.
8. **Writes are optimistic and conflicts are visible.** `base_revision` is
   the answer revision the client last saw, null only when it has never seen
   a record for that item. A mismatch, including null against an existing
   record, is 409 `stale_write` with the current server record; the dashboard
   shows both choices (load theirs, or save mine over the named revision) and
   never overwrites silently. Saves of one item from one tab are sent one
   after another, each naming the revision the previous acknowledgment
   returned; a pending autosave is flushed with `keepalive` when the page is
   left. Commits may carry `expected_revision` of the session (409
   `stale_session` on mismatch), and the commit transaction itself refuses
   with 409 `stale_session` if any answer changed after the snapshot was
   assembled, so the frozen record is exactly what was reviewed.
9. **Committing is explicit and final.** `POST /sessions/:id/commit/:stage`
   refuses with 422 `incomplete` listing `missing`, `unsure` and `invalid`
   items (drafts are kept). On success it snapshots every answer with a
   `snapshot_sha256`, records the committing authority and time, and the
   stage's answers become immutable (409 `stage_committed` on later saves,
   409 `already_committed` on a second commit).
10. **Post-exposure changes are revisions beside the baseline.**
    `POST /sessions/:id/revisions/:itemId` records a new Stage A reading
    with `exposure: { committed_at, revealed: { B, C }, after_exposure_to,
    blind: false }`. The committed answer is never modified, and the export
    of revisions is a separate file.
11. **A changed packet is a conflict the operator resolves.** When the
    packet on disk changes, reads carry `packet_conflict` (both hashes) and
    writes are refused. `POST /sessions/:id/rebind` with `{ confirm: true,
    from_packet_sha256, to_packet_sha256 }` starts a new session bound to
    the new hash, carries every Stage A answer over as a draft flagged for
    re-check, marks the old session `superseded_by`, and keeps it. Exposure
    travels with the person, not the packet: the successor inherits the old
    session's `revealed_at` times, every session read reports `blind` and
    `exposure_before_a` (the B/C reveal times that precede, or will precede,
    its Stage A commit), and the dashboard warns on the Stage A review, the
    export panel and the task card when a session is not blind. The
    dashboard discards all stage content, answers and drafts of the old
    session when it switches to the successor.

## Authority

12. **Reads need the ordinary Nexus session; writes need Robert.** Every
    write passes `authority.js`: a Cloudflare Access operator session
    (`access_user`, or `access_device` on a trusted device) or the bearer
    `NEXUS_OPERATOR_APPROVAL_KEY` (`operator_credential`). Service users,
    Praxis bridge headers, the document executor key, the runtime key and
    the placeholder dev token are refused with 403 `operator_required`; a
    missing operator configuration is 503. The dashboard sends the
    credential only on writes and keeps it in tab-scoped session storage.
    Each stored answer, commit, revision and export records which authority
    produced it.

## Exports and the Groundrules workflow

13. **Exports are written only to the fixed gold-set targets.**
    `POST /sessions/:id/exports/:kind` writes `labels/robert.json` (A),
    `judgments/robert.json` (B), `judgments/robert-vpu.json` (C) or
    `post-exposure/robert-revisions.json` under the configured gold dir and
    nowhere else. The stage must be committed (412 `stage_not_committed`).
    Documents carry `annotator`, `kind`, `blind`, `rosterSha256`,
    `guidelineSha256`, `labeledAt` (the commit time) and a `provenance`
    block (`collectedWith`, task, session, packet and commit hashes,
    authority). `blind` is computed, never assumed: it is false when Part B
    or C had been revealed at or before the Stage A commit (a session
    rebound after a reveal), and the provenance then adds `notBlind`,
    `exposureBeforeCommit` and `carriedFrom` so a post-exposure record can
    never pass as a blind baseline.
14. **Existing files are never clobbered.** A target written by someone
    else (different provenance) is refused with 409 `export_conflict`; an
    identical document is a no-op; an earlier export of the same session
    is first copied to `post-exposure/history/` and then replaced.
15. **Scorer compatibility is proven in isolation.**
    `server/__tests__/groundrules-labeling-export-roundtrip.test.js` copies
    the real packet and roster into a temp gold dir, answers every item
    synthetically through the API, exports, and runs
    `python3 -m src.ledger goldset` from the Groundrules repo against the
    temp directory. It asserts the scorer accepts the documents and that the
    real gold set gained no labels, judgments or post-exposure files.
    Robert's real labels are written only when he triggers an export from
    the workbench.

## Non-goals and caveats

- No scoring hints, AI label suggestions or pre-filled answers on real
  passages; the form definitions use invented examples only.
- The dashboard's quote resolver gives immediate feedback; the server
  re-checks every save and the scorer remains the authority for anchoring.
- Numeric values are a number or a plain decimal string (`"10"`, `"2.5"`);
  anything else is 400 `malformed_answer`, never coerced.
- A user-supplied `within` is checked in the scorer's own scope: it must
  resolve exactly once in the whole source unit (the section the row was cut
  from, read from the corpus the packet pins by sha256 under
  `data/ledger/sources`), not only in the displayed passage. A span that
  repeats in the unit (`within_not_unique_in_unit`), is absent from it
  (`within_not_found_in_unit`) or cannot be checked because the corpus file
  is missing or does not match its pin (`within_unverifiable`) keeps the
  answer a draft and blocks the stage commit; nothing ambiguous is exported.
- The API route mounts in `server/server.js`; the live :4000 picks it up
  only after a restart of the supervised API child.
- The interface does not change task status, approve anything, dispatch
  scoring or close need `163e050c`.
