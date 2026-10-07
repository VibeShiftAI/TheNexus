# Actionable alerts implementation plan

**Goal:** Every dashboard alert that asks Robert to act states the action and links to the existing decision surface; historical events do not impersonate current requests.

**Architecture:** A pure action resolver combines immutable activity events with authoritative HITL/task reads. A bounded read-only loader supplies evidence to the activity feed; the shared inbox card and bridge ticker reuse the same presentation rules. Unknown/unavailable state stays explicit. No event, task, or HITL data is rewritten.

**Stack:** Next.js/React, TypeScript, existing react-markdown/remark-gfm, node:test/jsdom.

- [x] Add regression tests for pending/resolved/unknown events, terminal task lifecycle records, red-alert acknowledgment, saved answers, safe links, and a capped/deduplicated read budget. Run with `node --import ./test/register.mjs --test src/lib/__tests__/alert-action.test.ts src/components/__tests__/alert-action.test.mjs` from dashboard; observe missing feature failures before implementation.
- [x] Add `dashboard/src/lib/alert-action.ts`, `dashboard/src/hooks/use-alert-action-state.ts`, and `dashboard/src/components/alert-action.tsx`. Require explicit evidence before marking resolved; preserve exact question/answer. Allow internal routes and HTTP(S) links only. Limit detail fetches to 20 per refresh, four in flight, and shared IDs once per refresh.
- [x] Integrate with `activity-feed.tsx`, `hitl-card.tsx`, `bridge/event-ticker.tsx`, and `lib/nexus/projects.ts`. Existing `requires_action` is a historical flag, not proof that Robert still owes input. Route live requests to `/inbox#id`; task contract review can link to `/task/id#contract-hold`.
- [x] Repair `app/inbox/page.tsx` hash navigation by fetching the named request when absent from pending, showing full resolved question/answer, or an explicit unavailable/missing state. Do not reopen or answer requests.
- [x] Extend dashboard voice facts, speech, and chat archive with exact current question/action/link; recheck current request before composition/archive/playback. Preserve the October 2 pairing algorithm.
- [x] Harden `use-hitl-inbox.ts` against stale reads and retained-frame mount races, separate background refreshing from initial loading, and preserve typed answers. Mirror runtime TTL semantics in cards, queue, and voice.
- [x] Run scoped new and adjacent tests: 67 passed, 0 failed. Build with `NEXT_DIST_DIR=.next-alert-verify npm run build`: exit 0, TypeScript passed, 29/29 pages. Restore build-added tsconfig/next-env changes. Live `.next` untouched.
- [x] Save the read-only audit and verification evidence in `/Volumes/Projects/reviews/praxis-alert-audit-2026-10-06.md`. Independent source review completed; parent performs live UI validation. Runtime producer/chat/push repairs are handled separately by parent, with lifecycle limitations recorded in this report.

Working tree inspection found existing document-review/server changes; none overlap the owned source files. Work proceeds in the existing checkout for its supervised development dashboard. No commit, restart, external message, or live-data mutation is part of this patch.
