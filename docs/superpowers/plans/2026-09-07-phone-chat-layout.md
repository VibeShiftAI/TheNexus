# Phone chat layout implementation plan

**Goal:** Keep the Nexus bridge readable at the connected Pixel 9 Pro's 427 CSS-pixel width and make the sections below chat reachable without traversing its message history.

**Design:** Retain the shared dashboard and its current controls. Bound the embedded chat to 420px with a viewport-aware phone cap, and make its transcript the scroll container. Use narrower phone gutters and arrange the core orb beside its status on phones. Keep the desktop core and chat side by side. Preserve the mounted conversation when maximizing or restoring chat.

**Cause and baseline:** At 427 × 860 with the real 31-row conversation loaded, the core measured 18,195px and the transcript 17,602.5px. The viewscreen's `flex-1` competes with its declared height in a column with an automatic minimum size. Its height must remain definite, and its flex children must be allowed to shrink.

**Files:** `dashboard/src/components/bridge/praxis-core.tsx` (viewscreen sizing, phone core classes); `dashboard/src/components/ai-terminal.tsx` (bounded scroll children); `dashboard/src/app/page.tsx` (phone gutters); `dashboard/src/app/globals.css` (phone presence layout).

- [x] Reproduce with live history and record the failing bounded-height check in the browser at 427 × 860.
- [x] Replace the embedded viewscreen's column `flex-1` with `flex-none lg:flex-1`, add `min-h-0` and a phone viewport height cap, and add `min-h-0` to the terminal/transcript.
- [x] Change bridge workspace padding from `p-6` to `p-3 sm:p-6`. Lay out the core presence as an 80px orb beside status below 640px, with vitals and crew spanning the full panel width.
- [x] Verify the transcript is bounded, latest messages/composer are visible, scrolling the transcript preserves page position, and lower sections are reachable by page scrolling. Verify maximize/restore with the same conversation.
- [x] Check 427px at standard, 115%, and 150% dashboard scale; check 390px and desktop. Dashboard scale is an enlarged-layout stress test, not an exact emulation of Android font scaling.
- [x] Run existing dashboard tests and an isolated production build, review the task-only diff against saved pre-edit files, and record evidence.

Source backups are under `/Volumes/Projects/reviews/nexus-phone-layout-2026-09-07/before`. Existing unrelated working-tree edits are preserved. This is a CSS/layout correction; browser geometry is the relevant regression check, not a jsdom class-string assertion.

## Final verification

Full-width phone composer tools were moved below the draft. At 390px/150%, button tracks preserve 32px for tool icons and 40px for Send; all four SVG icons measure 24 screen pixels. The inbox header now wraps to prevent its font/count/open controls overflowing at this scale. These two supporting files are `dashboard/src/components/chat/composer.tsx` and `dashboard/src/components/hitl-inbox.tsx`.

Existing dashboard tests: 314 passed, 0 failed. Isolated production build: passed. Browser geometry and independent/page scrolling were verified with real message history. Maximize/restore retained an unsent draft and kept controls on screen. Full evidence, logs, pre-edit copies and the task-only patch are saved at `/Volumes/Projects/reviews/nexus-phone-layout-2026-09-07/`.

Browser emulation was used because no Android emulator image was installed. Native keyboard/gesture and exact WebView font scaling remain device checks.
