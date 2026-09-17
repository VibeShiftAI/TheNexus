# Bounded document review storage repair

Operator report URL: **https://nexus.vibeshiftai.com/documents/bb977fdf-5496-48bb-98bb-031421cc9c1a**.

Implementation and isolated verification are finished. Production receiver activation and mechanically finalized cross-executor QA remain pending, as already accepted with note under criterion 5. This is not a delivery-readiness announcement. The read-only live document check returned `file_state: ok`, `review: null`, the correct source task, and content byte-identical to the real report (SHA-256 in [verification.txt](verification.txt)). Anonymous public GET returned 302; an unauthenticated Python HEAD returned 403. No authenticated production-browser verification was claimed in this round.

## Repair and evidence

The exact reviewer command was run before any implementation edit:

```sh
node --import /Volumes/Projects/Praxis/node_modules/tsx/dist/loader.mjs /tmp/nexus-qa-ledger-persistence.mts
```

Before: `firstStatus:200`, `durableReceiptExists:false`, `retryReply:processed-2`, `processedTurns:2`. After: `firstStatus:503`, `durableReceiptExists:false`, `retryStatus:200`, `retryReply:processed-1`, `processedTurns:1`. The first failed claim now runs nothing; retry after storage recovery runs exactly once. Both outputs are captured in [verification.txt](verification.txt); original logs remain `/tmp/nexus-ledger-before.log` and `/tmp/nexus-ledger-after.log`.

`Praxis/src/chat-idempotency.ts` persists a candidate map before publishing a claim or completed receipt in memory. File contents and the renamed directory entry are synced. Storage failures propagate to the route. Claims from interrupted handlers, cache loss, another boot, stale requests and legacy failures cannot authorize reexecution. A completion write failure keeps an explicit uncertain cache record; if that write also fails, the original durable in-progress claim remains the recovery barrier. Ledger reads fail closed. Records are not automatically evicted by count or age, since evicting an uncertain claim or delayed receipt would permit duplicate processing. This remains a single supervised-daemon store, not a distributed lock; deliberate future archival must preserve deduplication evidence.

`Praxis/src/routes/chat.ts` returns 503 `idempotency_storage_unavailable` before processing if the claim cannot be saved. After processing, failed receipt persistence returns 409 `outcome_uncertain`, `retryable:false`, with no successful response. Repeated requests cannot run that turn again. An agent error after processing also becomes uncertain. A saved receipt survives response loss and can be recovered from disk. Unkeyed requests follow the prior flow. No operator reconciliation or automatic replay mechanism was added.

The red test run failed at all three unsafe expectations: abandoned replay, claim failure returning 200, and receipt failure returning 200. Final `cd /Volumes/Projects/Praxis && npm test -- chat_idempotency`: **9 passed, 0 failed**. Regressions drive the real isolated HTTP route with the agent stubbed and ledger rename/read faults: claim refusal; safe recovery after cache loss; receipt failure; repeated refusal in the same cache, after cache loss and a new module boot; read-fault refusal and saved-receipt recovery; processing errors; and response loss followed by disk-only recovery. `npx tsc --noEmit` passed with no output. Typechecking caught an obsolete retry-counter expression, which was removed. Self-review also moved response transmission outside the receipt-persistence catch so a transport error cannot be mislabeled as a storage failure.

Nexus `server/__tests__/document-review-receiver.test.js` now checks both wire outcomes through the real worker and HTTP relay: a refused claim gets a scheduled keyed retry; an uncertain outcome preserves verbatim submission data and the user row, has no receipt/reply row or scheduled retry, survives worker restart, and cannot be reprocessed by explicit retry. `npx jest document --runInBand`: **5 suites, 38 tests passed**.

## Acceptance checklist

1. **Settled PASS, preserved:** Nexus task output/artifact entry points and a stable authenticated direct URL open the actual reliability report in a full-format shared Markdown reviewer; verify desktop and mobile rendering and controls. Fresh focused UI suites pass; isolated Chrome at 390px and 1440px rendered the copied actual report, visible phone composer, saved note and desktop receipt. Inspected [phone composer](390-note.png), [saved phone note](390-saved.png) and [desktop delivery](1440-delivered.png). `dashboard/next.config.ts:54` preserves the `/api/:path*` proxy; `dashboard/src/app/task/[id]/page.tsx:351` renders `ReviewDocumentsPanel`.
2. **Settled PASS, preserved:** Passage/block and whole-document feedback drafts persist through refresh and another client session, retain quoted context and immutable reviewed revision, and handle changed documents without silently moving anchors. Fresh `npx jest document --runInBand` includes `documents-route.test.js:132` and `:180`; browser check resumed the phone draft on desktop.
3. **Repaired and verified:** Finish review durably submits all verbatim feedback plus summary/context/link to the existing Praxis conversation; isolated integration tests prove receipt, retry after outage/response loss, duplicate suppression and no pre-submit delivery. Zero-comment finish works. Praxis 9/9 and Nexus 38/38 cover the new persistence boundaries plus existing receipt/format/no-pre-submit/zero-comment behavior (`document-review-delivery.test.js:47`, `:170`, `documents-route.test.js:223`, `:268`). The isolated browser receiver recorded one turn containing the full note, summary, document revision, task/project and link, followed by a saved conversation receipt.
4. **Settled PASS, preserved:** Document access and review APIs enforce existing auth and path boundaries; focused tests cover traversal/symlink escape, unsafe Markdown, invalid documents, save failures and submission failures without losing drafts. Fresh Nexus document suites cover these boundaries and faults; the focused dashboard Markdown tests pass. No security-boundary implementation was edited.
5. **Settled PASS with activation note, preserved:** The real reliability report is registered and linked from its source task. Walkthrough includes its tested operator-facing review URL, test/visual evidence and all changed repos. Execution finished, activation and mechanically finalized cross-executor QA are distinguished; report link is surfaced to Robert after readiness. Live GET confirms document `bb977fdf-5496-48bb-98bb-031421cc9c1a`, task `6f6017f3-a752-417f-a3a7-28602892c4f2` and unchanged report bytes. The URL is first in this walkthrough for the completion handler. Praxis PID 78118 started September 10 at 07:38, before this repair; it was not restarted. Praxis/Robert must activate through the normal live gates and the completion handler must finalize QA before announcing delivery readiness.

## Reusable browser check

The reviewer's `/tmp/nexus-ui-iso/verify.mjs` now compares parsed pathnames. The reusable version and both fixtures are saved in `scripts/document-review-qa/{verify.mjs,api.cjs,receiver.cjs}`, with repeatable setup in its `README.md`. The fixture checks its temporary directory, refuses an existing database and registers a canonical copy of the report. During verification its first registration correctly failed the path boundary because macOS `/var` differed from `/private/var`; the fixture now supplies the real path. Production path validation was preserved.

Executed `NEXUS_REVIEW_QA_DIR=/var/folders/rl/tstg952n00b_lvzcn18dfqw40000gn/T/nexus-document-review-qa.OMGieeQW2c node scripts/document-review-qa/verify.mjs` against isolated dashboard :3100, API :4100, receiver :4199. Exit 0; `hitIsTextarea:true`, `noteListed:true`, `DESKTOP_DRAFT_RESUMED true`, `DELIVERED_WITHOUT_RELOAD true`, `API_CALLS_SINCE_FINISH { finish:1, submissionPolls:2, retries:0 }`, one receiver turn. Full output: [browser-verification.txt](browser-verification.txt). All isolated listeners were stopped. Only this run's Next-generated tsconfig additions were removed; exact pre-run bytes were restored.

Dashboard command: `cd dashboard && node --import ./test/register.mjs --test src/components/__tests__/document-review.test.mjs src/components/__tests__/document-markdown.test.mjs src/components/__tests__/review-documents-panel.test.mjs` — **15 passed, 0 failed**. No dashboard product source was edited, so the settled production-build evidence was not reopened.

## Files, repositories and attribution

Before edits, both dirty trees were inventoried. The main feature remains in **/Volumes/Projects/TheNexus**; **/Volumes/Projects/Praxis** was added through the workspace endpoint before its first write (`action:add`, response kept primary workspace TheNexus). It is the only additional repository touched and is necessary for the receiving ledger. No other repository was edited. Existing dirty files were reread before narrow edits; prior work and staging were preserved. Nothing was committed, pushed or broadly staged; task status was not changed.

This run's modifications to previously dirty files, counted against saved pre-edit bytes via `git diff --no-index --numstat` (not against HEAD):

| Repository | Path | Added | Removed |
|---|---|---:|---:|
| Praxis | `src/chat-idempotency.ts` | 65 | 36 |
| Praxis | `src/routes/chat.ts` | 32 | 10 |
| Praxis | `tests/chat_idempotency.test.ts` | 114 | 9 |
| TheNexus | `server/__tests__/document-review-receiver.test.js` | 45 | 0 |
| TheNexus | `docs/superpowers/specs/2026-09-10-markdown-document-review-design.md` | 4 | 2 |

New TheNexus files: `docs/superpowers/plans/2026-09-10-document-review-storage-repair.md`; the four `scripts/document-review-qa/` files named above; this evidence directory's `walkthrough.md`, `binding-constraints.md`, `verification.txt`, `browser-verification.txt`, `390-note.png`, `390-saved.png`, `1440-delivered.png`, and `sha256.json`. External scratch change: `/tmp/nexus-ui-iso/verify.mjs` (pathname counters only). Generated isolated Next output is ignored; dashboard tsconfig has no net change from this run.

Pre-edit inventory, files and this run's review patches: `/tmp/nexus-ledger-repair-baseline/`. The authoritative cross-round candidate diff is also nonempty: `git diff deb6cda1a98e2a0a338ecd1bf6c031c3a57d8650 --stat -- src/chat-idempotency.ts src/routes/chat.ts tests/chat_idempotency.test.ts` shows 3 files / 624 insertions; Nexus's two existing candidate files show 298 insertions against `8a898a7d990404b41eee763a045ef4667d16096a`. These totals include prior-round work and are not claimed as this run's authorship.

Both quality gates passed. All changed text files received an explicit UTF-8/mojibake scan using Praxis `check-text-encoding.ts`; focused `git diff --check` passed. Own uncommitted patches and new fixture files were reread end to end: no unresolved correctness issue, debug code, placeholder or unused import found. Mechanical cross-executor QA is separate and pending. Binding constraints are reproduced verbatim in [binding-constraints.md](binding-constraints.md), carried with this walkthrough.

PRAXIS_QUALITY_GATES: verify=Praxis npm test -- chat_idempotency 9/9; Nexus npx jest document --runInBand 38/38; dashboard focused suites 15/15; isolated browser check exit 0; code-review=clean after removing obsolete retry counter and separating response transmission from receipt persistence
