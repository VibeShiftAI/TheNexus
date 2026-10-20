# Nexus menu: all items accessible

Task 91f1f758-4b40-464b-a2a0-29f29de0bf98, 2026-10-20. Robert asked to expand THE NEXUS MENU so every item can be seen, "perhaps another column or a cool design".

Revised the same day by task 584f2f1d-e03a-471d-911b-f530a2f89917 after Robert's review of this document. This file describes the menu as it is now; evidence from the original redesign is kept and labelled historical.

## Revision: Active Projects removed (task 584f2f1d)

**Source.** Document review submission cd98d2e4-9733-4db2-b753-da7b6cb65800 (review 1fe9e495-654e-4167-b975-761e382cc853, submitted 2026-10-20T18:28:35.248Z) on revision 4516e1e3-23ba-44c8-b191-ca9674a2aec0 of this document (SHA-256 79952de1698c2213d3db920f9dc5f9fe8b5abacca5207af14a2929cab402d9d6). Robert's feedback, verbatim: "remove the list of Active Projects from this menu, I already have that on the dashboard." He finished the review with the approve-after-changes grant, so the resulting revision is approved on his behalf through `scripts/record-document-approval.js` once registered. That approval covers this document revision only; independent QA of the task is separate.

**What changed.**

- `dashboard/src/components/nav-sidebar.tsx`: the Active Projects section (heading, count, project grid, "Loading projects..." status and "No active projects" text) is gone on every screen size, along with its menu-only `getProjects()` fetch, the `projects` and `loading` state, and the now-unused `getProjects`, `Project` and `FolderGit2` imports. Nothing else in the menu changed.
- Projects stay on the dashboard: the home page's PROJECT REFERENCE grid (`dashboard/src/app/page.tsx:211`, cards rendered at `page.tsx:226`) still lists every project, and each card links to `/project/<id>`.
- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs`: the old loading/40-project/empty test is replaced by one that asserts the menu has no Active Projects text, no project links, no loading status, only the Operate, Knowledge and studio, Models and systems, Controls and Model Aliases headings, and makes no `/api/projects` request (`nav-sidebar-menu.test.mjs:159`).
- `dashboard/scripts/nav-menu-browser-check.mjs`: the last-project target is gone; the check now fails if the open menu shows a project link, the heading or its loading/empty text (`nav-menu-browser-check.mjs:426`), or if the dashboard grid behind it does not list every fixture project (`nav-menu-browser-check.mjs:427`).

**The menu now (desktop and phone).** Pinned header with THE NEXUS MENU and Close; Reviews as the featured card; Operate, Knowledge and studio, and Models and systems (14 destinations); the Controls column with Local Only and Model Aliases; pinned footer with Settings, plus Connection settings in the Android shell. On a phone it is the same content in one column, ending at Model Aliases.

**Fresh validation for this revision (2026-10-20).**

- Browser check: the updated `nav-menu-browser-check.mjs` against an isolated `next dev` on :3100 (`NEXT_DIST_DIR=.next-menu-revision`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:4299`), every `/api/*` request answered from fixtures, live :4000 and :4299 blocked. Every run exited 0 with 0 blocked live-API requests:

| Fixture | Viewports | Menu project links | Dashboard project links | Result |
| --- | --- | --- | --- | --- |
| default (8 projects) | all 9 | 0 | 8 | all targets reachable, no sideways overflow, page scrollY 0, 21 Tab stops, behaviour ok |
| long (42 projects) + Android shell | all 9 | 0 | 42 | same, 22 Tab stops; Connection settings posted one `open-settings` and closed the menu |
| empty projects | all 9 | 0 | 0 | behaviour ok, no "No active projects" text in the menu |
| loading (projects request never answered) | all 9 | 0 | 0 (dashboard still loading) | behaviour ok, no loading status in the menu |
| reduced motion | 1280x720, 390x844 | 0 | 8 | panel does not animate |
| offline (connection banner up) | 1440x900, 1024x600 | 0 | 8 | Close and every target reachable over the banner |

  The nine viewports are 1440x900, 1280x720, 1024x600, 390x844, 375x667, 720x450 at 2x (200% zoom), 1280x720 at display scale 1.5, and 390x844 and 320x640 with root text at 200%. Each run scrolls the menu to its end (wheel on desktop, touch drag on phones), hit-tests Close, Reviews, LARS, Studio, the last destination, Local Only, Save Alias, Settings and Connection settings, walks the menu with Tab and Shift+Tab, and closes it with Escape and the backdrop, checking that focus returns to the hamburger. Reports: `2026-10-20-nexus-menu/reports/revision-*.json`.
- Unit tests: `node --import ./test/register.mjs --test` over `nav-sidebar-menu`, `nav-sidebar-shell-settings`, `nav-sidebar-lars-link` and `ready-for-review` tests: 19 pass, 0 fail. Run against the pre-revision component, only the new absence test fails (9 pass, 1 fail).
- `cd dashboard && npm test`: 1027 tests, 1018 pass, 9 fail. All 9 are in `src/lib/__tests__/voice-command-bar.test.ts` (43 pass, 9 fail when run alone), the known pre-existing announcement failures, unrelated to the menu.
- `dashboard/node_modules/.bin/tsc --noEmit -p .`: clean. `NEXT_DIST_DIR=.next-menu-revision-build npm run build`: exit 0.

**Screenshots (fresh, from the default and long fixtures above).**

- `2026-10-20-nexus-menu/desktop-after.png`: 1440x900, menu open. Destinations, Controls and Model Aliases, then Settings; no project section.
- `2026-10-20-nexus-menu/mobile-after.png`: 390x844, menu scrolled to its end: Models and systems, Controls, Model Aliases, then Settings; no project section.
- `desktop-long-names-after.png`: 1440x900 with the 42-project fixture and the Android shell footer (Connection settings beside Settings). The long project names now appear only on the dashboard.
- `mobile-320-text200-after.png`: 320px phone at 200% text (cramped mode) scrolled to the end: Save Alias, then Connection settings and Settings.
- `desktop-1024x600-after.png` and `mobile-375-shell-after.png` were recaptured and are byte-identical to the originals, because the project section sat below the fold in those frames.

The original versions of the four changed images are kept in `2026-10-20-nexus-menu/history/` with a `-with-projects` suffix. Earlier revisions of the registered desktop and phone images also remain in Nexus document history.

## What was wrong (historical, reproduced before the original redesign)

The old drawer (`dashboard/src/components/nav-sidebar.tsx`) was a 448px column with `overflow-hidden` on its wrapper and no scrollable body. Its content was 1945px tall, so at 1440x900 everything below Knowledge Ingestion was cut off with no way to reach it. The browser check on the unchanged code (`reports/before-default.json`) found, at every one of the 8 viewports:

- unreachable: Studio, Local Only, the model alias Save button, the last project, Settings, and LARS Dashboard everywhere below 900px tall (Connection settings too in the Android shell run);
- the mouse wheel or a touch drag scrolled the page behind the menu (page scrollY 960 to 1016) and never the menu;
- keyboard: focus stayed on the hamburger after opening, and 60 Tab presses never entered the menu;
- on phones the voice dock (z-50, later in the DOM) sat on top of the menu over LARS Dashboard;
- with the connection banner showing (offline), the banner covered the Close button at 1440x900.

Screenshots: `2026-10-20-nexus-menu/desktop-before.png` (1440x900), `mobile-before.png` (390x844), `desktop-1024x600-before-after-wheel.png` (after 60 wheel steps: the menu has not moved).

## Layout chosen

Three options compared in the original redesign:

- **Scroll-only narrow drawer.** Smallest change, but 14 destinations, two controls and (then) the project list stay in one long 448px column. On a laptop that is two or three screens of scrolling to reach Settings, and it does not answer "see all the items".
- **Full-screen menu.** Everything visible, but on desktop it hides the page the menu is for, wastes width on short labels, and on a phone it is the same as a sheet anyway.
- **Wide grouped panel (chosen).** A left slide-over up to 72rem wide (976px at 1024, 1152px at 1440) keeps a sliver of the page and the backdrop visible. Destinations sit in two columns under three headings, the controls get their own column, and the phone gets a full-width single-column sheet. At 1440x900 every destination and both controls are visible without scrolling. (The original version also ran projects below in up to three columns; the revision removed them.)

Structure of the menu now:

- **Header (pinned):** THE NEXUS MENU (the dialog's accessible name) and a 44px Close button labelled "Close menu".
- **Body (the only scroller):** Reviews as a featured amber card first, then Operate (Activity, Task Board, Ops, Session), Knowledge and studio (Academy, Council Chamber, The Codex, Knowledge Ingestion, Intake Report Log, Studio), Models and systems (Model Control, System Monitor, LARS Dashboard with an external-link mark). The Controls column holds Local Only and Model Aliases. There is no project list and no nested scroll.
- **Footer (pinned):** Settings, plus Connection settings and the app version inside the Android shell (side by side when they fit, stacked at large text).
- **Cramped mode:** when the pinned header and footer would take more than 40% of the panel (a 320px phone at 200% text), the whole panel becomes the one scroller, the header stays sticky so Close is always on screen, and the footer follows the list.
- **Labels and colours:** the old labels' subtitles became hint lines ("Activity / Live system report"), and each destination keeps its icon and colour.

## Behaviour and accessibility

- `role="dialog"`, `aria-modal`, `aria-labelledby` on the title; nav landmark "Nexus destinations"; group headings.
- **Focus:** opening moves focus into the panel. Tab and Shift+Tab wrap inside it. Escape, the backdrop, Close, any destination and Settings close it. Focus returns to the opener, falling back to the hamburger in Safari, where a clicked button never takes focus, and focus is not stolen if it already moved elsewhere.
- **Closed menu:** the wrapper is `inert` and `invisible`, so it takes no focus or clicks. Visibility transitions only on close; on open the Chrome visibility transition had blocked the focus move.
- **Page behind:** `documentElement` overflow is locked while open and restored to its previous value, including on unmount while open. The body uses `overscroll-contain`.
- **Motion and targets:** `motion-reduce:` removes the slide and fades. Links, buttons and the Local Only switch are at least 44px tall, and the alias form controls are 44px below the lg breakpoint via a wrapper selector (ModelAliasManager itself is unchanged).
- **Stacking:** z-[70], above the voice dock (z-50) and connection banner (z-60), below the audio mini player (z-90) and Settings modal (z-100). The footer's bottom padding includes `--nexus-floating-overlay-bottom`, so the mini player or the travel-shell feedback launcher cannot sit on Settings. Safe-area insets pad the header, sides and footer.
- **Unchanged behaviour:** LARS keeps `target="_blank" rel="noreferrer"` and its LAN URL. Local Only sends the same PUT (`enabled`, `reason: "manual_override"`). `<ModelAliasManager compact />` is unchanged. Connection settings appears only when `useMobileShell()` finds the shell and posts `{ type: "open-settings" }`. Settings calls `onOpenSettings()` then `onClose()`. Project pages are reached from the dashboard's project cards (`/project/<id>`). No permissions, API, config or routes changed.

## Validation for the original redesign (historical, task 91f1f758)

These results were recorded before the revision, when the menu still had its Active Projects section; the fresh results for the current menu are in the revision section above.

**Browser check.** Headless Chrome via CDP: `dashboard/scripts/nav-menu-browser-check.mjs` against a second `next dev` on :3100 (`NEXT_DIST_DIR=.next-menu`). Every `/api/*` request was answered from a fixture by request interception, and live :4000 and :4299 were blocked: 0 requests reached them, and no production data was read or written. The viewports were the same nine listed above. For each it scrolled the menu with the wheel (touch gestures on phones) and hit-tested Close, Reviews, LARS, Studio, the last link, Local Only, Save Alias, the last project, Settings and Connection settings, plus the overflow, page scroll, Tab, Shift+Tab, Escape, backdrop, focus-return, closed-menu and touch-target checks.

| Fixture | Viewports | Result |
| --- | --- | --- |
| default (8 projects) | all 9 | all targets reachable, no sideways overflow, page scrollY 0, behaviour ok |
| long (42 projects, unbroken 81-character name, long type) + Android shell | all 9 | same; Connection settings posted exactly one `open-settings` and closed the menu |
| empty projects | all 9 | "No active projects", all other targets reachable |
| loading (projects request never answered) | all 9 | "Loading projects..." status, all other targets reachable |
| reduced motion | 1280x720, 390x844 | panel has `transition-property: none` |
| offline (connection banner up) | 1440x900, 1024x600 | Close and every target reachable over the banner |

Those reports are `2026-10-20-nexus-menu/reports/before-*.json` and `after-*.json`. The same check also passed against a production `next build` (`NEXT_DIST_DIR=.next-verify`) served by `next start` on :3299 at 1440x900, 1024x600, 390x844 and text200. That run predated cramped mode; the production build was rebuilt and compiled cleanly, but was not browsed again.

**Tests at the time:**

- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs` (new then, 10 tests, jsdom mounting the real component) covered dialog semantics, focus, page lock, every close path, every destination in its group, Tab wrapping, the then-present projects loading, 40-project and empty states, the overflow restore, the Safari opener fallback, Local Only, Settings and Connection settings. Against the pre-redesign component, 7 of the 10 failed and the 3 behaviour-preservation tests plus Escape-while-closed passed, as intended. The revision replaced the projects test with the absence test described above; the file still has 10 tests.
- `nav-sidebar-shell-settings.test.mjs` and `nav-sidebar-lars-link.test.mjs` passed unchanged. `ready-for-review.test.mjs` pinned the old `navItems` array; its menu assertion checks the featured Reviews item rendered first.
- `cd dashboard && npm test`: 1027 tests, 1018 pass, 9 fail, all 9 in `voice-command-bar.test.ts`. `tsc --noEmit`: clean. `NEXT_DIST_DIR=.next-verify npm run build`: exit 0. Strict UTF-8 scan over the edited text files: clean.

**Review.** An independent code review of the original redesign found no high-severity defects. Its findings were fixed: the footer grid could overflow sideways at 320px with 200% text (now `minmax(min(10rem,100%),1fr)`); the Safari opener; test isolation and a no-op assertion; 44px targets not enforced on phones; headless Chrome left running when the check errors. The 320px case also led to cramped mode and word wrapping for long labels.

## Files

Original redesign (task 91f1f758, commits `b5d7ee0` menu and tests, `7a7a987` browser check, `4e9e566` walkthrough and images):

- `dashboard/src/components/nav-sidebar.tsx` (redesign)
- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs` (new)
- `dashboard/src/components/__tests__/ready-for-review.test.mjs` (one assertion updated)
- `dashboard/scripts/nav-menu-browser-check.mjs` (new)
- `docs/reviews/2026-10-20-nexus-menu.md` and `docs/reviews/2026-10-20-nexus-menu/` (this walkthrough, screenshots, reports)

Revision (task 584f2f1d, commit `954e72f` for the code, plus the commit that carries this document and its images):

- `dashboard/src/components/nav-sidebar.tsx` (Active Projects section and its fetch removed)
- `dashboard/src/components/__tests__/nav-sidebar-menu.test.mjs` (projects test replaced by the absence test)
- `dashboard/scripts/nav-menu-browser-check.mjs` (asserts the absence and the dashboard grid)
- `docs/reviews/2026-10-20-nexus-menu.md` (this revision), the refreshed images, `2026-10-20-nexus-menu/history/` and `reports/revision-*.json`

All commits are local on main and not pushed.

## Limitations and activation

- **Live now.** The live :3000 dashboard is the Praxis-supervised `next dev` and hot-reloads from the working tree, so it already serves the menu without Active Projects. No API or Praxis restart is needed.
- **Process restart during the original verification (historical).** While stopping a throwaway production server, the original task used a name-based kill that also hit the live :3000 `next-server` and TheGayGuyde.com's `npm run start` on :3777. Both supervisors respawned them within about a second. The revision stopped its throwaway server by port PID only and did not touch any live server.
- **Offline banner on phones.** When Nexus is unreachable, the connection banner (`connection-banner.tsx`, z-60, 92vw wide at the top) covers the hamburger button on a 390px phone, so the menu cannot be opened until the banner clears. This predates the redesign and is outside this task's scope. Once the menu is open it sits above the banner. It is worth a small follow-up, for example keeping the banner clear of the header's left edge.
- **Settings modal focus.** Settings closes the menu and returns focus to the hamburger, which sits behind the Settings modal. `SettingsModal` has no focus handling of its own, so it should take focus itself; that is a separate component.
- **Not tested on real devices.** The Android WebView, iOS Safari and the Windows travel shell were not exercised. Phone sizes, touch and text scale were emulated in desktop Chrome. Locking `html` overflow hides a classic scrollbar while the menu is open, which can shift the page behind it slightly on Windows.
- **Next dev indicator hidden.** The check hides Next's dev-only issues badge (`nextjs-portal`) because it is dev tooling, not the app; on the live dev server it can still overlap the bottom-left corner.
- **Independent QA for the revision has not run yet.** The revision section records the executor's own verification; Robert's delegated approval of this document revision is not QA of the task.
