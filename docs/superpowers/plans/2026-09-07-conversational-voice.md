# Conversational Voice Implementation Plan

> Execute inline in the already isolated worktree; parent owns runtime integration and review.

**Goal:** Complete spoken replies and conversational task announcements without overlapping playback.

**Architecture:** Add a small shared speech owner, an abortable voice session, and alert selection/scheduling helpers. Connect the existing voice bar and chat players to those helpers; preserve existing chat freshness and manual replay behavior.

**Tech Stack:** React, TypeScript, node:test with the dashboard jsdom/esbuild loader.

- [x] Write failing tests in dashboard/src/lib/__tests__/voice-speech.test.ts for chunk preservation, ownership preemption, canceled deferred synthesis, sequential playback, and stale cleanup. Implement dashboard/src/lib/speech-ownership.ts and voice-speech.ts, then rerun.
- [x] Write failing tests in dashboard/src/lib/__tests__/voice-alerts.test.ts for mode migration, actual stream event selection, bounded persisted dedupe, active-client gating, quiet hours, deferred wakeup and disposal. Implement dashboard/src/lib/voice-alerts.ts, then rerun.
- [x] Add integration regressions for cross-player interruption and pending autoplay. Wire use-chat-audio.ts, cortex-provider.tsx and chat/message-row.tsx into shared ownership.
- [x] Wire voice-command-bar.tsx to owned sessions throughout fetch, recording and playback; retain all text, use returned audio, and add explicit settings and elapsed recording UI. Add focused component regressions.
- [x] Run node --import ./test/register.mjs --test src/lib/__tests__/voice-*.test.ts src/hooks/__tests__/chat-audio-autoplay.test.ts and npx tsc --noEmit --incremental false from dashboard; inspect scoped diff and commit only owned files, excluding dependency symlinks.

Verification evidence (2026-09-07): the focused dashboard run includes the new voice lifecycle, alert scheduler, voice bar, and chat ownership suites, existing chat autoplay/model-control/history-merge coverage. Fifty tests passed. `npx tsc --noEmit --incremental false` passed. Scoped diff review checked state ownership after awaits, resource cleanup, actual event fields, alert preference migration, and excluded dependency symlinks. Parent integration completed: the production webpack build passed, the 14 scoped files were applied after baseline comparisons, all 43 focused voice/audio tests and TypeScript checks passed in the live checkout, and browser verification confirmed the live Bridge with Conversational alerts selected. No microphone was activated. The local Qwen provider remained healthy through the rollout. Independent spec and quality reviews approved code commit `8c45f1b`.

Boundaries: no continuous follow-up listening, STT migration, streaming audio transport, or relocated global voice bar. Native microphone and real audio were not activated during testing. Initial-silence detection requires a working Web Audio analyser; without it recording retains manual stop and the sixty-second cap. Automatic alerts expire after ten minutes to avoid an overnight backlog, and only events newer than the mounted voice bar are eligible. Cross-tab exclusion uses Web Locks when available; unavailable storage/locks degrade to session dedupe and active-client gating. Existing chat manual replay and three-minute autoplay freshness remain intact.

Activation records, scoped rollback patches and additional voice opportunities: `/Volumes/Projects/praxis-voice-lab/results/activation/OPERATIONS.md`.
