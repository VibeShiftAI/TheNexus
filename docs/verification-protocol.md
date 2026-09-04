# The TheNexus Verification Protocol

**Status:** codified 2026-07-25 (Upgrade Council slate 2026-07-24, rank 5; source signal:
`shared-mind/memories/note_project_reflection_thenexus_2026-07-23.md`).
**Protocol on file:** `project-execution-cadence`
(`shared-mind/skills/protocols/project-execution-cadence.md`), adopted per that reflection and
stamped on the Nexus project card (`Protocol:` line in the project description — that stamp is
what the reflection engine reads, so keep it if the description is rewritten).
**Enforcement code of record:** the Praxis runtime —
`Praxis/src/orchestrator/verification-protocol.ts` (verdicts),
`Praxis/src/executors/quality-gates.ts` (self-verification gates),
`Praxis/src/orchestrator/qa-dispatch.ts` (cross-executor audit) — documented in
`Praxis/docs/verification-protocol.md`. TheNexus builds no verification machinery of its own;
this document codifies how that machinery, plus this repo's own test surface, applies to
TheNexus work. If prose and code disagree, fix whichever is wrong, in the same change.

## Purpose

TheNexus is the cockpit — the instrument Robert trusts while Praxis runs unattended. Work on
the instrument must itself be verifiable, or the trust is circular. The 2026-07-23 reflection
found the method here quietly healthy on throughput (31 small, vertical, well-scoped tasks
landed with zero blocks) but entirely implicit: no protocol on file, and the one failure on
record was a brief with no verifiable acceptance condition. This document makes the method
explicit so drift gets caught while it's cheap, instead of by habit.

## The brief standard (the gate that was missing)

Every TheNexus task brief must state **1–3 verifiable acceptance criteria** — conditions an
executor can test and a QA reviewer can hold the diff against.

- A criterion is verifiable when it names an observable: a test that asserts the behavior, a
  command whose output can be checked, a URL that renders the thing, a refusal that can be
  provoked.
- Conceptual or security goals ("preserve instruction provenance", "deny privileged tools to
  untrusted content") must be **rewritten into testable assertions before dispatch** — e.g.
  "derived content tagged untrusted CANNOT invoke tool X; a test asserts the refusal." A brief
  whose done-state cannot be checked is not dispatchable; it is a pre-paid correction loop.
- Both recorded failure shapes came from breaking this rule: the `bad_spec` post-mortem on the
  provenance-trust-boundaries task (conceptual goals, nothing to test against) and the
  near-duplicate "4M Daily Limit" re-dispatch (first brief stated no pass condition, so the
  same ground got worked twice).
- Keep the task sizing that already works: beachhead-sized, single-verb, concrete units with
  an obvious done-state ("fix 404 on Calendar", "implement local callAI() provider"). Vertical
  slices — Node + Python + dashboard + types landing together — are the sustain, not a smell.

## The evidence model (inherited from Praxis)

Every TheNexus task dispatched through Praxis carries the standard two legs of evidence, and
gets a permanent machine-readable verdict (verified / uncertain / partial / unverified) on the
append-only run-events spine at finalization:

- **Leg A — self-verification.** The implementing run declares both quality gates with real
  evidence on the `PRAXIS_QUALITY_GATES:` line: *verify* (exercised the change end-to-end —
  real command, real output) and *code-review* (re-read its own diff).
- **Leg B — independent audit.** A cross-executor QA reviewer — structurally never the author —
  audits the task-scoped diff **against the brief's acceptance criteria** and returns a
  verdict. This is why the brief standard above is load-bearing: the criteria are the QA
  reviewer's contract.

The verdict rules, evidence-chain grading, fail-open recording, and abstention semantics are
Praxis's and are not restated here — see `Praxis/docs/verification-protocol.md`.

## The verify surface (what leg A means in this repo)

A real leg-A verify for TheNexus work exercises one of these, scoped to the change:

- **Server:** the jest suite — `npm test` (all server suites; green at codification —
  the board's end-state criterion declares 37 suites / 240 tests) or
  `npx jest server/<area>` for a scoped run. New server behavior lands with a test in
  `server/**/__tests__/`.
- **Dashboard:** `npm run build` in `dashboard/` (the compile is the floor), plus driving the
  affected page/component against a running server when behavior changed.
- **API:** hit the affected route on the live cockpit (`:4000`) and show the response.
- **Contract changes:** the wire contract lives in ONE place, the sibling repo `../nexus-shared`
  (server: `file:../nexus-shared`; dashboard: `file:../../nexus-shared`). A contract change is
  not verified until `npm run build` has run in `nexus-shared` and both consumers (server and
  dashboard) compile against the rebuilt `dist/`.

A typecheck or lint alone is not a verify; docs-only changes say so instead of inventing a
command.

## The stopping rule

"Done" is decided by the declared **end-state criteria** on the Nexus project card, verified
by the weekly steward — currently: cockpit API serving the board (url_up), dashboard reachable
(url_up), server suite green (command), and the attribution-and-trust task-set frontier. Not
by vibes, and not by the end-state prose alone. When the criteria pass, the honest move is an
AAR and a proposed next horizon (end states are versioned; evolving them is the success path)
— never silent stalling, and never unmanaged drift into new surface area.

## Cadence (per `project-execution-cadence`)

- **One-slot WIP** machine-wide; the day scheduler owns sequencing — don't fight the gate with
  parallel ambitions.
- **Let the QA loop work:** corrections go back to the author, 3 strikes → blocked + automatic
  post-mortem. The loop's records are the raw material of reflection.
- **Mid-project reflection** runs on the automated weekly cadence against this protocol; its
  CHANGE items must route to real artifacts (task / need / protocol-amendment), or the
  reflection was a diary entry.
- **Amendments** to this protocol ride `protocol-evolution` — staged, human-approved,
  rollback-safe.

## The instrument closes the loop

The evidence this protocol produces is what the cockpit itself displays: the end state's
Evidence surface — a completed task surfaces its walkthrough, verify/code-review gates, and QA
verdict one click deep, and a completion without evidence looks visibly unverified, never
quietly green. TheNexus is both governed by the protocol and the place where its output is
read; keeping the two aligned is part of any change to either.
