# Combined blocked-task voice alerts

Approved by Robert on 2026-10-02 after reproduction: task.blocked speaks immediately;
hitl.created for the same suspension speaks again after the 120-second cooldown.

Goal: one voice announcement containing task, blocker and question, without delaying
board or inbox updates. Keep unrelated questions independently actionable.

Architecture: coalesce in the dashboard voice queue. Prefer blockedOnHitlId;
otherwise match a task-question to the nearest same-task block within 10 seconds.
Pair one question to one block. Hold an unpaired block or task-question up to 10
seconds, then announce it alone. A question arriving after the fallback is new
information and must still be delivered. Preserve active-device, quiet-hour,
speech-owner, tab-lock and event-ID deduplication checks. Retain a bounded recent
queue so telemetry does not evict a waiting alert. No contract/runtime changes.

Acceptance:
1. Both arrival orders produce one announcement with blocker and question; both
   event IDs are covered across queue updates and scheduler recreation.
2. Missing questions time out; distinct questions and unrelated tasks remain
   separate. Exact mismatched question IDs never merge.
3. Recheck pairing after async device lookup and before playback. Existing voice
   safety and rate-limit tests remain green.

Implementation steps (inline execution):
- [x] Add failing scheduler regressions in dashboard/src/lib/__tests__/voice-alerts.test.ts.
  Run: node --import ./test/register.mjs --test src/lib/__tests__/voice-alerts.test.ts
- [x] Add a small voice-alert-pairing.ts selector; integrate VoiceAlerts, alertFacts
  and voice-command-bar.tsx. Announce receives the question and optional paired block.
- [x] Test both orders, timeout, late question, explicit identity, separate questions,
  reload dedupe, telemetry eviction and async device races.
- [x] Run voice suites, typecheck and isolated dashboard build; independent code review.
- [x] Apply only verified files to the live checkout, check dashboard response and
  preserve unrelated work. Record evidence and activation limitations here.

Verification (2026-10-02): baseline 25 scheduler tests passed. New regressions
failed on duplicate playback before implementation. Final voice/audio suites:
211 tests passed. Includes mounted component integration proving one speech
request with blocker and question, and a late-block/prose/archive regression.
Independent reviewer reproduced the question-first preparation race; fixed by
releasing the obsolete reservation and composing with a distinct paired archive
identity. Review then passed; reviewer independently ran 88 tests.

Production verification: NEXT_DIST_DIR=.next-voice-verify npx next build --webpack
passed (compile, TypeScript and page generation). Webpack permits the isolated
worktree to reuse the installed dependency directory. No live build output or
Praxis daemon was restarted. Activation uses the existing dashboard dev server.
