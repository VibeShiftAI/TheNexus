# Dashboard schedule placement

**Goal:** Show Today's Schedule above the Praxis inbox on desktop and immediately after the chat/core panel on mobile.

**Design:** Preserve the two independently flowing desktop columns at the existing xl breakpoint. Below xl, use display: contents on the column wrappers and CSS order on their children to produce core, schedule, bridge stations, inbox/activity. Keep one mounted ScheduleTimeline instance and preserve the inbox navigation anchor on the inbox group.

**Scope:** dashboard/src/app/page.tsx only; React and Tailwind layout classes. No data or event behavior changes.

## Execution and acceptance

- [x] Inspect the existing cockpit layout and breakpoint behavior.
- [x] Move ScheduleTimeline before HitlInbox and apply responsive wrapper/order classes.
- [x] Run the existing dashboard tests and an isolated production build (NEXT_DIST_DIR=.next-verify). Build passes; dashboard tests are 1118/1123, with five reproducible failures in untouched chat/voice code; the cockpit layout test passes.
- [x] Drive the live home page at phone, tablet and desktop widths; measure schedule below core on narrow screens, above inbox on desktop, and check horizontal overflow.
- [x] Review the final diff and retain verification evidence under docs/reviews/2026-10-26-schedule-layout.

This reversible layout-only change uses existing tests plus rendered browser verification; it does not add source-string tests that mirror the implementation.
