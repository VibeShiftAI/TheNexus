# Nexus menu follow-up: control coverage and suite attribution

Task 68909e82-5c4d-530a-9f80-22cc740e477e, 2026-10-21. QA follow-up to task 91f1f758 (Nexus menu). The original task stays completed; this folder holds the evidence for the two approved suggestions. Earlier evidence in `../reports/` and `../*.png` is unchanged.

## Dispositions

| Suggestion | Disposition | Where |
| --- | --- | --- |
| 1 (reviewer): derive the Tab-walk length from the focusable controls instead of 60; size wheel steps to the scroll area | Implemented, plus every focusable control is now hit-tested, not just ten samples | `dashboard/scripts/nav-menu-browser-check.mjs`, commit 84660b0 |
| 2 (adversarial critic): attribute the 9 full-suite failures against baseline c193147 | Implemented: all 9 predate the menu change and are independent of it; no test changes status because of the menu | `attribution-table.md`, `attribute-suite-failures.sh` |

## Suggestion 2: the nine failures

Method (`attribute-suite-failures.sh`): run the dashboard suite (the `npm test` command line) in five throwaway detached git worktrees under /tmp, never in the working tree, with a node:test reporter (`outcome-reporter.mjs`) that records file, name and status for every test:

- `baseline`: c193147, the QA baseline of task 91f1f758;
- `baseline-plus-menu`: the baseline plus the three suite-visible menu files as the menu commits left them (e3230af): `nav-sidebar.tsx`, `nav-sidebar-menu.test.mjs`, `ready-for-review.test.mjs`;
- `head-without-menu`: HEAD with those three files put back to the baseline;
- `head`: HEAD (84660b0, including this task's footer fix);
- `control-old-assert`: HEAD with only `ready-for-review.test.mjs` put back to the baseline. This is a negative control for the critic's concern: an assertion on `nav-sidebar.tsx` text that was not updated must fail, and must be the only test that changes.

Results (`attribution-table.md:3-9`, raw console `attribute-run.txt`):

| Run | Tests | Pass | Fail |
| --- | --- | --- | --- |
| baseline | 1017 | 1008 | 9 |
| baseline-plus-menu | 1027 | 1018 | 9 |
| head-without-menu | 1049 | 1040 | 9 |
| head | 1059 | 1050 | 9 |
| control-old-assert | 1059 | 1049 | 10 |

- The same 9 tests fail in every run, all in `src/lib/__tests__/voice-command-bar.test.ts` (`attribution-table.md:11-65`). They fail at the baseline, before any menu change, and they still fail with the menu removed from the current tree. So they are pre-existing and not caused by the menu. Their errors are announcement assertions (`0 !== 1`, `false == true`; TAP blocks in `failures-*.txt`). Neither the test nor `components/bridge/voice-command-bar.tsx` nor `components/live-board-state.tsx` references the menu.
- Across all five runs exactly one test changes status: the negative control's `ready-for-review.test.mjs` Reviews assertion (`attribution-table.md:71`). With the menu change applied (baseline-plus-menu, head), every test that reads `nav-sidebar.tsx` as text passes: `nav-sidebar-menu`, `nav-sidebar-shell-settings`, `nav-sidebar-lars-link`, `ready-for-review` and `studio-navigation` (22 tests, 12 without the 10 new menu tests). No regression in protected behaviour.
- The 10 tests present only with the menu are the new `nav-sidebar-menu.test.mjs` tests, all passing.
- `cd dashboard && npm test` on the working tree at 84660b0: 1059 tests, 1050 pass, 9 fail, the same 9 names (`npm-test-working-tree.txt:1-6`).

Environment notes: worktrees, not `git archive` copies, because `nexus-barrel.test.ts` walks git history; the script links the sibling `nexus-shared` repo (read by `daily-journal-tabs.test.ts`) and the installed `node_modules` into each worktree. Without those two, an archive copy shows 2 extra environment failures, which is why the first attempt was discarded.

## Suggestion 1: the browser check

What changed in `dashboard/scripts/nav-menu-browser-check.mjs`:

- **Every control.** The probe lists every control matched by the menu's own focus-trap selector (`FOCUSABLE`, line 97) and hit-tests each one after every scroll step. A control that is never fully on screen and hit-testable fails the run.
- **Wheel step from the scroll area** (line 401): a third of the scroller's visible height (excluding a sticky header), clamped to 24 to 240px, so any control up to two thirds of that height is fully on screen at some step. Scrolling continues until nothing moves for three steps; the cap (line 403) is three times the steps the range needs, and the run fails if the menu did not reach its end (line 522).
- **Tab walk from the control count** (line 457): one lap of the focusable controls plus two. It fails if a control is never focused (line 527), focus does not wrap to the first control (line 470), Tab lands outside the trap's list, or a focused control is off screen or covered (line 532).
- **Clipped controls** (line 280): a control running past the panel edge is reported, even when the panel's overflow hides it from the old sideways check.
- **Viewports:** 1280x400, 844x390 and 844x390 at 200% text join the matrix (lines 84-86). Ad hoc `<w>x<h>[-touch][-text200]` names are accepted (line 88). `CHECK_WHEEL_STEP` and `CHECK_TAB_STEPS` force fixed values for diagnosis.

Why it mattered (before evidence):

- **Tab walk.** In the original long-fixture run (`../reports/after-long-shell.json`, `"steps": 60` at line 438) the pre-revision menu had 64 focusable controls (22 menu controls plus 42 project links). The 60-step walk ended on "Fixture project 40" and never focused projects 41 and 42, Connection settings or Settings, yet the run reported no problems. That is the reviewer's "64 controls". The current menu has 21 controls (22 in the Android shell), so a fixed 60 happens to cover it now, but nothing checked that.
- **Wheel.** With a fixed 240px step, very short windows report false misses: Ops and Session at 1280x300, 1024x280 and 844x300, plus the alias field and scope select at 640x280 (`browser/console.txt:178-183`, exit 1). With adaptive steps the same windows reach 22 of 22 (`browser/console.txt:184-190`, exit 0). At 1280x400 and 844x390 the fixed step happened to pass (`browser/console.txt:31-39`) because the scroll area there (241 and 251px tall) is still just larger than the step.

Results with the final check, isolated `next dev` on :3100, every `/api/*` answered from fixtures, :4000 and :4299 blocked (0 blocked live-API requests in every run):

| Fixture | Viewports | Controls reached | Tab walk | Exit |
| --- | --- | --- | --- | --- |
| default | all 12 | 21/21 at each | 21/21, wrapped | 0 (`browser/console.txt:107`) |
| reduced motion | 1280x720, 390x844 | 21/21 | 21/21, wrapped | 0 (`browser/console.txt:112`) |
| offline banner | 1440x900, 1024x600 | 21/21 | 21/21, wrapped | 0 (`browser/console.txt:117`) |
| long + Android shell | all 12 | 22/22 at each | 22/22, wrapped | 0 (`browser/console.txt:135`) |
| empty | all 12 | 21/21 | 21/21, wrapped | 0 (`browser/console.txt:158`) |
| loading | all 12 | 21/21 | 21/21, wrapped | 0 (`browser/console.txt:173`) |

Failure paths (each exits 1 by design): `CHECK_TAB_STEPS=20` names the two controls it never reached, Connection settings and Settings, and the missing wrap (`browser/console.txt:137-140`); `CHECK_WHEEL_STEP=240` produces the false misses above.

## Defect found and fixed: Settings cut off at 200% text in the Android shell

At 844x390 with 200% text and the shell, the footer stayed one flex row (`sm:flex`) holding Connection settings (`sm:min-w-64`, 512px) and Settings (`sm:min-w-56`, 448px) in 652px. Settings ran from x=576 to x=1024, past the panel edge at 748; its label showed as "Setting" and its centre hit the backdrop. The check reported it as unreachable, focused under another element, and past the panel edge (`browser/console.txt:86`, exit 1; screenshot `browser/settings-844x390text200-before-fix.png`). The footer comment already said "large text stacks them"; `sm:flex-wrap` (`dashboard/src/components/nav-sidebar.tsx:290`) makes it do so. Afterwards Settings is 22/22 reachable at that size (`browser/console.txt:133`; `browser/settings-844x390text200-after-fix.png`). At normal text the two buttons need 488px (16rem + 14rem + the 0.5rem gap), and the narrowest sm+ footer has 544px (a 592px panel at the 640px breakpoint less its 1.5rem padding each side), so the row layout is unchanged there; all 12 matrix viewports still pass.

## Retained for relevance review (not changed here)

Exploratory desktop sizes with the root font at 200% (`browser/console.txt:192-197`, `browser/reports/report-explore-desktop-text200.json`):

- **1024x600:** 8 of 22 controls reachable. The `lg` grid gives the controls column 16 to 20rem, which is 512 to 640px at 200%, leaving the destinations about 144px split into two columns. Labels break per character, and the cards grow taller than the scroll area (`browser/explore-1024x600-text200-open.png`). There is also a "Knowledge and studio" heading spill.
- **1280x400:** the LARS card is 359px tall in a 263px scroll area, so it can never be fully on screen. It stays clickable while scrolling (`browser/explore-1280x400-text200-scrolled.png`).
- 1280x720 and 1440x900 at 200% text pass.

Caveat: the check emulates large text by setting the root font size, which does not move rem-based media queries. A browser's own default font size does move them, and would switch these sizes to the one-column layout that the matrix covers (text200, 320text200). The finding applies where text scales but breakpoints do not, for example Android WebView text zoom on a tablet-width screen. Fixing it means changing the parent's grid breakpoints, which is a design decision. It is therefore retained as a suggestion, not changed in this follow-up, and these sizes are not in the default matrix.

## Reproduce

```
bash docs/reviews/2026-10-20-nexus-menu/followup/attribute-suite-failures.sh        # about 75s, rewrites the outcome files here
cd dashboard
NEXT_DIST_DIR=.next-menu-followup NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 ./node_modules/.bin/next dev -p 3100
CHECK_BASE=http://localhost:3100 CHECK_FIXTURE=long CHECK_SHELL=1 node scripts/nav-menu-browser-check.mjs
```

`next dev` with its own dist dir appends that dir's types to `dashboard/tsconfig.json`; discard that rewrite afterwards.

## Files

- `attribute-suite-failures.sh`, `outcome-reporter.mjs`, `suite-outcomes.mjs`: attribution tooling.
- `attribute-run.txt`, `attribution-table.md`, `outcomes-<run>.tsv` (every test per run), `failures-<run>.txt` (TAP of each failure), `npm-test-working-tree.txt`.
- `browser/console.txt` (every browser-check run in order, including the unchanged check and an intermediate version), `browser/reports/*.json` (final-check reports), four screenshots.
