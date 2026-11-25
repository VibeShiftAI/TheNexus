# Reviews re-sort: what stayed, what moved to Reference

2026-11-25, Nexus task dcc2a7be. Done under your ruling "go with C"
(`nexus://conversation/a821fe1e-4d76-4a3f-82e1-8872be4ac289/message/8f6068f1-bbe7-4200-b59c-9d9bebf27469`).
This is for reference only; nothing here needs an answer.

## In short

- 28 documents were in Needs your review when the task started. I read each one
  along with its tasks, reviews, decisions and your messages. No decision,
  review or new version touched any of them between the start of the task
  (14:46 UTC) and the re-sort (16:56 UTC).
- **10 stayed.** For 7, a question in the document's own text is waiting for
  your answer, so I recorded that question on the document. For 2, something
  was already waiting on them. 1 stayed because I was not sure.
- **18 moved to Reference.** Nothing was waiting on them.
- No approval or request for changes was recorded, and nothing was sent or
  published. The decision log had 31 entries before and 31 after.
- **To put one back:** open it and choose **Move to review queue**. It returns to
  Needs your review as your own request. The re-sort never moves it again.

## What stayed, and why (10)

**A question in the document waits for your answer (7).** The question now
shows on the document as "A decision is waiting for your answer: ...".

| Document | What is waiting |
|---|---|
| Bao business blueprint (interactive page), 34fb831e | Is the updated page ready to send to Cat? You approved an earlier version. This version has the reframing and wording fixes you asked for, so it should not go to Cat until you have read it. |
| Mise: sending feedback from the app, deb69249 | Is Feedback where you would reach for it with a timer running? The document recommends keeping the current placement. |
| QA test answer key: control set and why good work is rejected, e061d1e8 | Should the nightly QA test switch to a new answer key? The document recommends approving one measurement run first. |
| Git cleanup report and revival review (2026-11-14), b01d6a2f | Two revival choices: cherry-pick Praxis 91e176d3, and revive TheCortex's prompt-receipt fixtures in a separate task. |
| Client status report system: review and recommendations, baf089b5 | Three choices: who owns each row, what an operator is told when something fails, and whether the Meeple item belongs in a client report. Its other three recommendations were overtaken by later work. |
| Retire proposal: scheduled jobs and skills (Subtraction Audit 4/4), dadd93dd | Six blocks: pause J1 to J10; confirm O1, O2, O3, O6 and O7 as retired; whether to pause any of the weak keeps W1 to W13; archive D1 to D10, U1 to U7 and R1 to R52. Only the memory pair and the three trading jobs have been handled so far. |
| Invented limits audit: keep or remove, 660b14bc | What to do with the 44 limits most likely to block you today, then the 989 name-a-source rows. Most of the 44 are still in the code. |

**Something was already waiting on it (2).**

| Document | What is waiting |
|---|---|
| Failed document deliveries: what Robert never received, 4da2602c | Sixteen recover-or-skip choices on this version are unanswered. None of those files will be registered until you make them. |
| Praxis story for r/SideProject (first draft), de213f39 | You asked for changes on November 10. This version has the three edits that your November 11 review said would make it approved. Only you can record that approval, so it stays. |

**Not sure (1).**

| Document | Why it stayed |
|---|---|
| Can a paused task still finish?, 9b88f69f | Its answer ("yes") is disputed by a QA follow-up you approved this morning (slate e231ce616cca, item 49af36dad0e3). That follow-up is not a task yet, and Praxis advised you not to approve this document yet. After the restart it will show under Tagged, nothing waiting. |

**Answering a recorded question.** Answer it the way you answer any review
today: put your answer in a review or tell Praxis in chat. The re-sort only
records the question so the document says why it is waiting; nothing acts on
your answer by itself. The line goes away at your next decision on the document
(Approve document, or Request changes). If you answer only in chat, the line
stays until you make one of those decisions.

No document among the 28 had a guard that would have kept it from moving: no
unsent mail, draft comments, waiting tasks, open replacement work or waiting
agent review. So none stayed for that reason. The script checked every guard
again just before each move.

## What moved to Reference, and why (18)

| Document | Why nothing waits on it |
|---|---|
| Inkling 2 Mini live test, run by day, deededaf | The live test kept Gemma as the primary model and changed nothing. Its task (7222ac5c) passed QA and merged, and the result reached you in chat on November 25 after you asked how the test went. |
| Ops panel, compact: before and after, 3373f198 | Before-and-after screenshots of a change you asked for, which is merged and live (task 52b5db3d). |
| Test store guard: design, inventory and verification, ea231651 | It reports on a test guard that is merged (task 033719fe) and asks you nothing. |
| Test suites on main: what failed, why, and what changed, 2a7317ac | Its one question was a free model seat on the trading council. That question lapsed when you had the council retired and its failing tests removed (task aa32a9dc). |
| Inkling 2 Mini readiness report, 31c7c4e3 | You approved the graph repair, and the live test it prepared has run and answered its questions (deededaf). A side note is still open; see Side notes. |
| Ops graphic: every running agent, real logos, 9fccff0a | It is live, you have seen it, and the follow-up change you asked for has shipped (task 52b5db3d). |
| Second-critic objections: what resolving them would have cost and caught, 092e3210 | You acted on its result in chat on November 23, and the log-only trial it proposed is built (task ed1827bc). |
| Catalog live: did the test inquiry arrive?, 0d86bfd7 | You confirmed in chat on November 23 that the test inquiry arrived. |
| Catalog live: your copy edits on the live pages, cf0e2947 | You reviewed the live pages and emailed your edits on November 23. What is open now is Praxis's two chat questions about those edits, not this document. |
| e2 QA judge: input completeness and rerun noise, 11cb8b59 | A finished measurement report that later e2 work built on (tasks b33cc320 and fb6f4c0b). It asked only for approval as ready. |
| Planted-error check of the batch judge (task 3.6), d7c7a259 | It confirms a repair rule you had already ruled on, which is built and has since been revised. It asked only for sign-off. |
| Open task audit: which of the 65 waiting tasks are still valid, 6238f7a5 | You made every call in it, in chat on November 20 and in your review on November 21, and all of them have been carried out. Praxis's decision record shows all 65 choices answered from that review and acted on. |
| Frozen e2 QA adjudication audit, 17 November 2026, 1839506f | A finished audit whose recommended follow-up work later e2 tasks have done (08e95982, f35f65e4, b33cc320, fb6f4c0b). |
| Full-record and inherited correction handoffs on retained Praxis tasks, d8930325 | An experiment report whose own recommendation is to adopt neither candidate yet. It asked only for approval as ready. |
| Status report: one modular template with About this report, 10f0cc76 | Your November 21 review approved it with no changes, and the template is merged and deployed. That approval was never recorded, and this re-sort records no approvals. |
| Bowery Princes: Clay intake questions (wording review), 0c7881be | You reviewed it and asked for it to be closed. Your rewording went into the intake, and Clay has answered. |
| Projects catalog: the words on the pages, b4d626f1 | You said you would not review this text again and would judge the live site instead. The site launched with your 30 edits. |
| Praxis story for X (thread draft), b80faa43 | A Claude Code session registered this draft on its own. You asked for an X version, but not to review it here, and its own text holds posting until stages ship. |

The open task audit (6238f7a5) needed one exception. Its 65 choices were
declared as decision items, and you answered them in the free text of your
November 21 review. Nexus keeps no structured copy of those answers, so the new
rule on its own would have read all 65 as still open. The script moved it only
after reading Praxis's decision record at that moment and confirming that every
one of the 65 has an answer. If you ever put it back, it will say 65 decisions
are waiting; they are not.

## How to put one back

Open the document and choose **Move to review queue** in its review panel.
That one action returns it to Needs your review as your own request, and it
works the same before and after the restart. The move record stays with the
document (marked as reopened), and the re-sort will never move it a second
time. Every moved document kept its comments, history and links.

## What happens now, and what waits for a restart

Already done, on the live database:

- The 18 moves took effect at 16:56 UTC. The current dashboard already counts
  10 in Needs your review instead of 28.
- The activity feed has 18 entries reading "Moved ... to Reference". None of
  them asks you to do anything.
- A backup taken just before the change is at
  `/Volumes/Projects/TheNexus/backups/nexus-2026-11-25-before-reviews-resort.db`.

After this task lands and the Nexus API restarts (nothing has been restarted):

- Needs your review lists only documents with something waiting on them (9
  today). Each one says what is waiting.
- A separate view, **Tagged, nothing waiting**, holds the rest (1 today:
  9b88f69f). The home page's Reviews count matches Needs your review.
- A moved document shows why it moved. Until the restart, that reason is blank.
- A new document sent for review with nothing waiting on it is filed as
  reference, and the reason is recorded. Praxis keeps working unchanged. Its
  reference-only documents are not announced in chat right away, and the QA
  completion notice lists them as reference only. A document from a chat
  session with no task gets no chat link until Praxis's follow-on change lands.
- The project Deliverables and task panels still count every document tagged
  for review; this task did not change them.

## Side notes (yours, none blocking)

- Inkling readiness report (31c7c4e3): it says removing twelve older live_test
  episodes from the graph is your call. It makes no recommendation, and nothing
  waits on it.
- Test inquiry (0d86bfd7): the project checkpoint for the inquiry still has no
  dated evidence. Your November 23 chat answer is that evidence.
- Approvals never recorded: 10f0cc76 (moved) and de213f39 (stayed). Only you
  can record them.
- Four sent "Update for Joey Lautrup" emails (0307c9d3, fa93b383, 4499b6de,
  201a36bc) are tagged for review but do not appear in Reviews because they
  are mail. Their mail is sent; they were left as they are.

## What was written

- Live database: 18 move records (each citing your ruling, this task and what
  the reading found), 18 activity entries, review grounds on the 7 documents
  above, and the additive schema changes these need. No decision rows.
- The plan with every outcome and finding is
  `scripts/reviews-resort-2026-11-25.json`, applied by
  `scripts/reviews-resort.js`. The rules are in section 15 of
  `docs/contracts/document-review-deliverables.md`.
