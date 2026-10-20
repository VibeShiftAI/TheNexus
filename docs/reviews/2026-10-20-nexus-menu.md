# Nexus menu: all items accessible

Task 91f1f758-4b40-464b-a2a0-29f29de0bf98, 2026-10-20. Robert asked to expand THE NEXUS MENU so every item can be seen, "perhaps another column or a cool design".

## What was wrong (reproduced before changing anything)

The old drawer (`dashboard/src/components/nav-sidebar.tsx`) was a 448px column with `overflow-hidden` on its wrapper and no scrollable body. Its content was 1945px tall, so at 1440x900 everything below Knowledge Ingestion was cut off with no way to reach it. The browser check on the unchanged code (`reports/before-default.json`) found, at every one of the 8 viewports:

- unreachable: Studio, Local Only, the model alias Save button, the last project, Settings, and LARS Dashboard everywhere below 900px tall (Connection settings too in the Android shell run);
- the mouse wheel or a touch drag scrolled the page behind the menu (page scrollY 960 to 1016) and never the menu;
- keyboard: focus stayed on the hamburger after opening, and 60 Tab presses never entered the menu;
- on phones the voice dock (z-50, later in the DOM) sat on top of the menu over LARS Dashboard;
- with the connection banner showing (offline), the banner covered the Close button at 1440x900.

Screenshots: `2026-10-20-nexus-menu/desktop-before.png` (1440x900), `mobile-before.png` (390x844), `desktop-1024x600-before-after-wheel.png` (after 60 wheel steps: the menu has not moved).

## Layout chosen

Three options compared:

- **Scroll-only narrow drawer.** Smallest change, but 14 destinations, two controls and the project list stay in one long 448px column. On a laptop that is two or three screens of scrolling to reach Settings, and it does not answer "see all the items".
- **Full-screen menu.** Everything visible, but on desktop it hides the page the menu is for, wastes width on short labels, and on a phone it is the same as a sheet anyway.
- **Wide grouped panel (chosen).** A left slide-over up to 72rem wide (976px at 1024, 1152px at 1440) keeps a sliver of the page and the backdrop visible. Destinations sit in two columns under three headings, the controls get their own column, projects run below in up to three columns, and the phone gets a full-width single-column sheet. At 1440x900 every destination, both controls and the first projects are visible without scrolling.

Structure:

- **Header (pinned):** THE NEXUS MENU (the dialog's accessible name) and a 44px Close button labelled "Close menu".
- **Body (the only scroller):** Reviews as a featured amber card first, then Operate (Activity, Task Board, Ops, Session), Knowledge and studio (Academy, Council Chamber, The Codex, Knowledge Ingestion, Intake Report Log, Studio), Models and systems (Model Control, System Monitor, LARS Dashboard with an external-link mark). The Controls column holds Local Only and Model Aliases; Active Projects shows a count and a grid with truncated names (full name in the tooltip) and type badges. The old inner `max-h-[40vh]` project scroller is gone, so there is no nested scroll.
- **Footer (pinned):** Settings, plus Connection settings and the app version inside the Android shell (side by side when they fit, stacked at large text).
- **Cramped mode:** when the pinned header and footer would take more than 40% of the panel (a 320px phone at 200% text), the whole panel becomes the one scroller, the header stays sticky so Close is always on screen, and the footer follows the list.
- **Labels and colours:** the old labels' subtitles became hint lines ("Activity / Live system report"), and each destination keeps its icon and colour.

## Behaviour and accessibility

- `role="dialog"`, `aria-modal`, `aria-labelledby` on the title; nav landmark "Nexus destinations"; group headings.
- **Focus:** opening moves focus into the panel. Tab and Shift+Tab wrap inside it. Escape, the backdrop, Close, any destination and Settings close it. Focus returns to the opener, falling back to the hamburger in Safari, where a clicked button never takes focus, and focus is not stolen if it already moved elsewhere.
- **Closed menu:** the wrapper is `inert` and `invisible`, so it takes no focus or clicks. Visibility now transitions only on close; on open the Chrome visibility transition had blocked the focus move.
- **Page behind:** `documentElement` overflow is locked while open and restored to its previous value, including on unmount while open. The body uses `overscroll-contain`.
- **Motion and targets:** `motion-reduce:` removes the slide and fades. Links, buttons and the Local Only switch are at least 44px tall, and the alias form controls are 44px below the lg breakpoint via a wrapper selector (ModelAliasManager itself is unchanged).
- **Stacking:** z-[70], above the voice dock (z-50) and connection banner (z-60), below the audio mini player (z-90) and Settings modal (z-100). The footer's bottom padding includes `--nexus-floating-overlay-bottom`, so the mini player or the travel-shell feedback launcher cannot sit on Settings. Safe-area insets pad the header, sides and footer.
- **Unchanged behaviour:** LARS keeps `target="_blank" rel="noreferrer"` and its LAN URL. Local Only sends the same PUT (`enabled`, `reason: "manual_override"`). `<ModelAliasManager compact />` is unchanged. Project links go to `/project/<id>`. Connection settings appears only when `useMobileShell()` finds the shell and posts `{ type: "open-settings" }`. Settings calls `onOpenSettings()` then `onClose()`. No permissions, API, config or routes changed.

Screenshots after: `desktop-after.png` (1440x900), `mobile-after.png` (390x844), `desktop-1024x600-after.png`, `desktop-long-names-after.png` (42 projects, long names, Android shell footer), `mobile-375-shell-after.png`, `mobile-320-text200-after.png` (cramped mode scrolled to the end).

## Validation actually run

**Browser check.** Headless Chrome via CDP: `dashboard/scripts/nav-menu-browser-check.mjs` against a second `next dev` on :3100 (`NEXT_DIST_DIR=.next-menu`). Every `/api/*` request was answered from a fixture by request interception, and live :4000 and :4299 were blocked: 0 requests reached them, and no production data was read or written. The viewports were 1440x900, 1280x720, 1024x600, 390x844 and 375x667; 720x450 at 2x (1440x900 at 200% browser zoom); 1280x720 at Nexus display scale 1.5; and 390x844 and 320x640 with root text at 200%. For each it scrolls the menu with the wheel (touch gestures on phones) and hit-tests Close, Reviews, LARS, Studio, the last link, Local Only, Save Alias, the last project, Settings and Connection settings. It also checks for sideways overflow and spilled text, page scroll, the Tab walk, Shift+Tab, Escape, the backdrop, focus return, closed-menu focusability and phone touch targets under 44px.

| Fixture | Viewports | Result |
| --- | --- | --- |
| default (8 projects) | all 9 | all targets reachable, no sideways overflow, page scrollY 0, behaviour ok |
| long (42 projects, unbroken 81-character name, long type) + Android shell | all 9 | same; Connection settings posted exactly one `open-settings` and closed the menu |
| empty projects | all 9 | "No active projects", all other targets reachable |
| loading (projects request never answered) | all 9 | "Loading projects..." status, all other targets reachable |
| reduced motion | 1280x720, 390x844 | panel has `transition-property: none` |
| offline (connection banner up) | 1440x900, 1024x600 | Close and every target reachable over the banner |

The reports are in `2026-10-20-nexus-menu/reports/` (`before-*.json`, `after-*.json`). The same check also passed against a production `next build` (`NEXT_DIST_DIR=.next-verify`) served by `next start` on :3299 at 1440x900, 1024x600, 390x844 and text200. That run predates cramped mode; the final production build was rebuilt and compiles cleanly, but was not browsed again.

**Tests:**

- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs` (new, 10 tests, jsdom mounting the real component) covers:
  - inert when closed, labelled dialog, focus in, page lock and release, focus return;
  - every close path, every destination listed in its group, Reviews first, LARS in a new tab;
  - Tab and Shift+Tab wrapping;
  - loading, 40-project and empty states;
  - the overflow value preserved and released on unmount;
  - Escape ignored while closed, and focus not stolen;
  - the Safari opener fallback;
  - the Local Only request, and Settings and Connection settings.
- Run against the baseline component, 7 of the 10 fail. The 3 that pass are the behaviour-preservation tests (Local Only, Settings and Connection settings) and the Escape-while-closed test, which the old drawer also satisfied, as intended.
- The existing `nav-sidebar-shell-settings.test.mjs` and `nav-sidebar-lars-link.test.mjs` pass unchanged. `ready-for-review.test.mjs` pinned the old `navItems` array; its menu assertion now checks the featured Reviews item rendered first.
- `cd dashboard && npm test`: 1027 tests, 1018 pass, 9 fail. All 9 are in `src/lib/__tests__/voice-command-bar.test.ts`, the known pre-existing announcement failures, which do not touch the menu.
- `dashboard/node_modules/.bin/tsc --noEmit -p .`: clean.
- `NEXT_DIST_DIR=.next-verify npm run build`: exit 0.
- Strict UTF-8 scan (fatal TextDecoder; checks for BOM, U+FFFD, mojibake and CR) over every edited text file: clean, with no em dashes.

**Review.** An independent code review found no high-severity defects. Its findings were fixed:

- the footer grid could overflow sideways at 320px with 200% text (now `minmax(min(10rem,100%),1fr)`);
- the Safari opener;
- test isolation and a no-op assertion;
- 44px targets not enforced on phones;
- headless Chrome left running when the check errors.

The 320px case also led to cramped mode and word wrapping for long labels.

## Files

- `dashboard/src/components/nav-sidebar.tsx` (redesign)
- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs` (new)
- `dashboard/src/components/__tests__/ready-for-review.test.mjs` (one assertion updated)
- `dashboard/scripts/nav-menu-browser-check.mjs` (new)
- `docs/reviews/2026-10-20-nexus-menu.md` and `docs/reviews/2026-10-20-nexus-menu/` (this walkthrough, screenshots, reports)

Commits on main (local, not pushed): `b5d7ee0` menu and tests, `7a7a987` browser check, plus the commit that adds this walkthrough and its images.

## Limitations and activation

- **Live now.** The live :3000 dashboard is the Praxis-supervised `next dev` and hot-reloads from the working tree, so it already serves the new menu. No API or Praxis restart is needed.
- **Process restart during verification.** While stopping my throwaway production server I used a name-based kill. It also hit the live :3000 `next-server` and TheGayGuyde.com's `npm run start` on :3777. Both supervisors respawned them within about a second, and both answered 200 afterwards, but open dashboard tabs will have reloaded. No data was involved.
- **Offline banner on phones.** When Nexus is unreachable, the connection banner (`connection-banner.tsx`, z-60, 92vw wide at the top) covers the hamburger button on a 390px phone, so the menu cannot be opened until the banner clears. This predates the redesign and is outside this task's scope. Once the menu is open it sits above the banner. It is worth a small follow-up, for example keeping the banner clear of the header's left edge.
- **Settings modal focus.** Settings closes the menu and returns focus to the hamburger, which sits behind the Settings modal. `SettingsModal` has no focus handling of its own, so it should take focus itself; that is a separate component.
- **Not tested on real devices.** The Android WebView, iOS Safari and the Windows travel shell were not exercised. Phone sizes, touch and text scale were emulated in desktop Chrome. Locking `html` overflow hides a classic scrollbar while the menu is open, which can shift the page behind it slightly on Windows.
- **Next dev indicator hidden.** The check hides Next's dev-only issues badge (`nextjs-portal`) because it is dev tooling, not the app; on the live dev server it can still overlap the bottom-left corner.
- **Independent QA has not run yet.** This walkthrough records the executor's own verification.
