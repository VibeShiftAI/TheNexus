# Praxis ops-events router: structured-field routing (criteria 2 and 3 of task b596adfc)

Follow-up task 9361cb8d, 2026-11-15. It settles the adversarial critic's two objections to the QA pass of
task b596adfc ("Finish the boilerplate sweep: task-screen note and structured outcome checks").

## Disposition: Suggestion 1 (adversarial critic). Declined as a code change, answered with evidence

No new Praxis code was needed. The critic only saw the final repair round's diff (TheNexus dashboard files).
The Praxis half of b596adfc landed in round 1 as Praxis commit `f567d391`, and that round's walkthrough
declared `/Volumes/Projects/Praxis` as the extra repo. This folder re-proves both objections against the
code as it stands now: Praxis `main` at `d2df4285`, TheNexus at `2ecc70c6`.

### Objection 1: criterion 2 is unproven for the Praxis ops-events router

Criterion 2 of b596adfc (from its acceptance_criteria): "No code path in TheNexus task-progress or the Praxis
ops-events router decides behavior by matching an English sentence; both read structured fields, with tests
showing a reworded message still routes and renders the same."

- **The change exists.** `git show --stat f567d391` in Praxis touches `src/ops-events-routing.ts`
  (21 lines changed), `src/comms/operational-brief.ts` and `tests/operational_brief.test.ts`. The commit carries the
  trailer `Task: b596adfc-ca0b-4908-8ae3-388d14457782` and is on Praxis `main` (`git branch --contains f567d391`).
- **What changed.** The router used to decide whether to add the "Independent quality review ..." line by
  regex-matching three English sentences against `current.situation`. That removed code is the `+` side of
  `regex-router-reverse.patch` in this folder (the patch turns current code back into the old form). Now:
  - the producer names the outcome once (`COMPLETION_QA_STATE`, Praxis `src/comms/operational-brief.ts:7`);
  - when the composed brief keeps the producer's own QA sentence, it records `metadata.briefStatesQa`
    (`BRIEF_STATES_QA_KEY`, `operational-brief.ts:30`, set in `enrichOperationalBrief`);
  - the router reads only that field: `src/ops-events-routing.ts:729`
    `if (qaState && event.metadata?.[BRIEF_STATES_QA_KEY] !== qaState) lines.push(COMPLETION_QA_LINE[qaState]);`
- **Nothing later undid it.** `git diff f567d391 HEAD -- src/ops-events-routing.ts` shows only three new
  `OVERRIDES` entries for newsletter ingestion (commit 4e8c1225); the routing decision is untouched.
- **No sentence matching is left in the router.** A grep of `src/ops-events-routing.ts` for
  `.test(`, `.match(`, `.includes(`, `startsWith`, `RegExp` turns up only:
  - event-type membership (`:506`, `:509`) and request-state membership (`:628`, `:690`, `:712`);
  - URL-path patterns for document links (`:754`, `:757`);
  - a length/newline shape check (`:577`);
  - `restates()` (`:429-433`), which compares a detail with the event's own title to avoid printing it
    twice (data against data, not a fixed English sentence);
  - `content.includes(event.message)` / `notice.includes(inboxLink(...))`, both dedupe against the event's
    own fields.

  The brief's example sentence "No action needed from you." never appears in Praxis `src` history
  (`git log -S"No action needed from you" -- src` prints nothing). The sentence matching that actually
  existed was the QA-outcome regexes removed above.
- **Tests prove a reworded message routes the same.** `praxis-tests.txt:39`
  "rewording the producer QA sentence still renders exactly one QA statement" and `:40`
  "the router reads the recorded QA claim, not the situation wording" pass, and so does `:41` (a model
  rewrite carries no claim, so the line is still shown).
- **Failure path: the tests bite.** In a scratch copy of Praxis HEAD (`git archive` into `/tmp`) with only
  the router decision put back to the old regex form (`regex-router-reverse.patch`), the same test file
  fails exactly the two rewording tests: `praxis-regex-router-tests.txt:13`, `:14`; tally `:16-19`
  (15 tests, 13 pass, 2 fail), `exit 1` at `:66`.

Out of scope, noted for relevance review rather than changed: `src/comms/operational-brief.ts:63-75` and
`:121` still match message text (`/memory governor|memory pressure/`, `/days since last successful
graph-cull/`, `/active writer/`, `/withheld|interrupted/`) to pick plain-language wording for other event
types. That is the brief composer, not the ops-events router that criterion 2 names, and it decides wording
rather than routing. Replacing it would mean adding fields to several other producers. This follow-up does
not create tasks, so it stays as a note.

### Objection 2: criterion 3 (Praxis tests and tsc in both repos) is unsupported

Criterion 3: "Existing dashboard and Praxis tests for these modules pass, plus tsc in both repos."

| Check | Command | Result (file:line) |
| --- | --- | --- |
| Praxis tsc | `npx tsc --noEmit -p .` in `/Volumes/Projects/Praxis` @ d2df4285 | `praxis-tsc.txt:1` `tsc exit 0` |
| Praxis module tests | `npm test -- operational_brief ops_events_routing ops_events_routing_precedence ops_events human_brief red_alert_human_brief qa_completion_announcement` | `praxis-tests.txt:120-123` tests 92, pass 92, fail 0; `:128` exit 0 |
| Dashboard tsc | `node node_modules/typescript/lib/tsc.js --noEmit -p .` in `dashboard/` | `dash-tsc.txt:1` `tsc exit 0` |
| Dashboard module tests | `node --import ./test/register.mjs --test src/lib/__tests__/task-progress.test.ts src/components/__tests__/task-progress-panel.test.mjs src/components/__tests__/task-improvements-panel.test.mjs src/components/__tests__/model-ladder-settings.test.mjs` | `dash-focused.txt:42-45` tests 41, pass 41, fail 0; `:50` exit 0; TheNexus rewording test at `:28` |

## Files in this folder

- `README.md`: this disposition
- `praxis-tsc.txt`, `praxis-tests.txt`: Praxis gates at d2df4285
- `praxis-regex-router-tests.txt`, `regex-router-reverse.patch`: failure-path check with the old regex router
- `dash-tsc.txt`, `dash-focused.txt`: TheNexus dashboard gates at 2ecc70c6
