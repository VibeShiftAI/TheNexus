# Voice interruption repair — 2026-10-09

The dashboard now excludes `task.failed` events explicitly marked
`failureRecoveryOwner: 'callback'`. These describe attempts whose recovery or
escalation is owned by the runtime callback. The callback's eventual actionable
HITL question is the interruption. Missing or unknown ownership remains eligible,
so a recovery-handler failure can emit an ordinary failure as a fallback.

The same ownership check runs before authoritative voice revalidation. Existing
active-client, speech ownership, quiet-hours, rate, request-resolution, and
block/question pairing checks remain unchanged. No broader time-based suppression
was added; independent questions on the same task remain deliverable. Existing
question facts and archived Inbox links remain the source of actionable detail.

Acceptance evidence:

- Added six tests; the initial scoped run had five expected failures and one
  passing fallback baseline (42 passed / 5 failed), demonstrating the duplicate
  failed-attempt announcement and lost immediate fallback.
- After the repair, ran from `dashboard/`:
  `node --import ./test/register.mjs --test src/lib/__tests__/voice-alerts.test.ts src/lib/__tests__/voice-alert-actions.test.ts src/lib/__tests__/voice-conversation.test.ts`
  — **80 passed, 0 failed**.
- Regressions cover both alert modes, silent automatic recovery, one canonical
  question with its exact Inbox destination, unowned failure delivery, and
  suppression before current-task lookup. Existing tests cover unrelated second
  questions, exact pairing, active-device checks, and speech ownership.
- Scoped `git diff --check` passed; reviewed the production diff (one ownership
  helper, two call sites). No pairing or speech-device code changed.

Transport inspection: `server/routes/praxis-stream.js` parses JSON and broadcasts
the event; `dashboard/src/lib/praxis-stream-store.ts` parses JSON with a type
assertion. Neither strips this optional field. The implementation therefore uses
a local structural extension without changing the shared contract package.

Integration requirement: runtime must mark owned attempts and create one canonical
request when its callback fails; emit an unowned failure only if it cannot create
that request. Legacy unowned producers retain their previous behavior, including
the possibility of separate raw-failure and generic Inbox announcements. Runtime
evidence and terminal-lane delivery review are tracked by the separate runtime
repair. A dashboard
production build and live browser verification are left to the parent integration
pass; no live events, speech, settings, restarts, or task mutations were triggered
by this scoped verification.
