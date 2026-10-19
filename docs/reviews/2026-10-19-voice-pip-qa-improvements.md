# QA improvements: collapse/expand pip on the global voice dock

- Task: 1599d9c7-cd7c-52ef-8d53-8d76dfc2bbb3, follow-up to completed task a10da6d9 (commit `ebf0e42`).
- Workspace: `/Volumes/Projects/TheNexus`, QA baseline `c03bfc9f48c6`. Nothing committed.
- Evidence lives next to this file in `2026-10-19-voice-pip-qa-improvements/` (`output/`, `scripts/`).

## Dispositions

| # | Source | Disposition |
| --- | --- | --- |
| 1 | reviewer: route Alt+Shift+V through the dock's expansion event and cover the collapsed shortcut | **Implemented**, plus a focus defect found while verifying it |
| 2 | adversarial critic: criterion 4 passed with the announcement-suite failures unexplained | **Resolved with evidence, no code change**: the 9 failures predate the parent change by at least six days, are byte-identical before and after it, and come from a test file that never loads the dock |

## Suggestion 1: Alt+Shift+V on a collapsed dock

### Defect

`voice-command-bar.tsx` handled the shortcut by calling `openSetup()` directly, so the dock's `VOICE_SETUP_EVENT` listener (`global-voice-dock.tsx:26`) never heard it. QA's `scripts/qa-shortcut.mjs` showed `collapsed:"true"` and `dialog visibility hidden` after the shortcut.

While verifying the fix in Chrome, a second defect showed up on the same path (and on the parent's launcher path): when the dock expanded from collapsed, the setup window opened but **did not take focus**. Output of `scripts/shortcut-focus-check.mjs` after the routing fix alone (this run, before the focus fix):

```
C shortcut   {"collapsed":"false",...,"dialog":true,"dialogVisibility":"visible","focusInDialog":false,"active":"BODY",...}
E shortcut   {"collapsed":"false",...,"dialog":true,"dialogVisibility":"visible","focusInDialog":false,"active":"BODY",...}
```

The control, the same shortcut on an already expanded dock, did focus it: `"focusInDialog":true,"active":"Talk to Praxis setup"`. There were two causes, each confirmed in the browser before any code change:

1. The bar wrapper transitioned `visibility`. At the start of a hidden-to-visible transition the computed value is still `hidden`, so the post-commit focus was refused. With the wrapper's `transitionProperty` overridden to `max-width, opacity` in the live page, case C focused (`"focusInDialog":true`).
2. When setup was already open, `openSetup()` only focused synchronously, before React had committed the expansion. With the override from (1) applied, case E still printed `"active":"BODY"`.

### Change

- `dashboard/src/components/bridge/voice-command-bar.tsx:667`: the shortcut dispatches `VOICE_SETUP_EVENT`, the event the "Talk to Praxis" launcher already uses. The bar's own listener still calls `openSetup`, and the dock's listener expands the dock. `openSetup` dropped out of the keydown effect's dependencies (`:672`).
- `voice-command-bar.tsx:117, :213, :216`: `openSetup` bumps a `setupFocusRequest` counter instead of focusing synchronously. The existing focus effect now also depends on that counter, so focus happens after the commit in which the dock expands.
- `dashboard/src/components/global-voice-dock.tsx:47`: `visibility` transitions only on collapse, so the fade-out still plays. Expanding shows the bar immediately.
- `dashboard/src/lib/__tests__/voice-dock.test.ts:80`: new test. On a saved-collapsed dock, a held (repeating) key leaves it collapsed with no setup window (failure path). The shortcut expands the dock and focuses setup. The class list asserts the expand has no visibility transition and the collapse has one. With setup left open and the dock collapsed again (focus dropped, as Chrome does), the shortcut expands the dock and refocuses the open window. jsdom has no CSS, so the test models the browser rule "hidden content cannot take focus" from the dock's own `data-collapsed` state.

### Verification

- Negative control in the shared tree, before any source edit: the new test failed with `'true' !== 'false'` (`output/dock-negative.txt:9`, `fail 1`), the same observation QA made.
- Partial-revert controls (`scripts/dock-negative-controls.mjs`, `/tmp` copies of the working tree with hunks reverted), `output/negative.txt`:
  - no fix: first failure `'true' !== 'false'`
  - routing only: `expanding shows the bar at once`
  - routing + CSS, synchronous focus: `the open setup window is focused again`
  - routing + focus, visibility transition on expand: `expanding shows the bar at once`
  - all fixes: `pass 5`, `fail 0`
- Live :3000 (hot-reloading `next dev`), `scripts/shortcut-focus-check.mjs` → `output/focus-after.txt`:
  - line 3, held key: `"collapsed":"true"`, `"dialog":false`
  - line 4, shortcut: `"collapsed":"false"`, `"dialogVisibility":"visible"`, `"focusInDialog":true`, `"transition":"max-width, opacity"`
  - line 6, shortcut with setup left open: `"focusInDialog":true`
  - The computed transition rules out a stale CSS chunk: collapsed rows print `"max-width, opacity, visibility"`.
- QA's own script rerun, `output/qa-shortcut-final.txt:6`: `after collapsed shortcut {... "collapsed":"false","visibility":"visible", ...} dialog visibility visible`. The earlier lines of the same run still show collapse, reload persistence, expand and the settings window working.
- No `Fast Refresh had to perform a full reload` line was logged for these edits. Both edited components export only components.

## Suggestion 2: the announcement-suite failures

The 9 failing tests are all in `dashboard/src/lib/__tests__/voice-command-bar.test.ts`: the five `announcement chat and voice visibility: *` cases, `a blocked task and its question produce one complete spoken announcement`, `a repeated announcement speaks its saved wording...`, `recomposed question uses a fresh archive identity...` and `two eligible live alerts each compose once...`.

1. **They predate the parent change.** `scripts/announcement-baseline.sh` extracts clean committed snapshots with `git archive` (the shared tree is never checked out) and runs that file in each:
   - `617e40f` (2026-10-18, parent of `ebf0e42`): `pass 43`, `fail 9` (`output/snap-617e40f.txt:55-56`)
   - `ebf0e42` (the parent change): `pass 43`, `fail 9` (`output/snap-ebf0e42.txt:55-56`)
   - `03ab428` and `9f933ff` (2026-10-13): also `fail 9` (`output/snap-03ab428.txt:56`, `output/snap-03ab428-parent.txt:56`)
   - The failing-name lists `output/failing-snap-617e40f.txt` and `output/failing-snap-ebf0e42.txt` are identical (`cmp`).
2. **The suite cannot see the dock.** `voice-command-bar.test.ts:9` imports `VoiceCommandBar` directly and mounts it without `GlobalVoiceDock`. `grep -rl global-voice-dock dashboard/src` lists only `app/layout.tsx`, `lib/voice-dock-preferences.ts` and two test files. The wrapper div, flex layout and collapse classes the critic cites are therefore absent from every failing test.
3. **The runtime announcement path does not depend on what the dock changed.** Announcements are gated only on `settingsOpenRef.current || document.hidden` (`voice-command-bar.tsx:572`) and `!settingsOpenRef.current && !document.hidden` (`:610`). Nothing reads element visibility or layout; `grep` finds no `getComputedStyle`, `getBoundingClientRect`, `offsetParent`, `IntersectionObserver` or `checkVisibility` in `voice-command-bar.tsx`, `voice-alerts.ts`, `voice-speech.ts`, `voice-conversation.ts` or `voice-alert-pairing.ts`. The dock's `VOICE_SETUP_EVENT` listener only calls `setCollapsed(false)`.
4. **No new failures anywhere.** Full dashboard suite on the working tree after this task: `tests 1006`, `pass 997`, `fail 9` (`output/full-after.txt:1026-1029`). The 9 failing names (`output/failing-full-after.txt`) are identical to the pre-parent snapshot's. The voice suites before any edit in this task (`output/before.txt:94-97`, 93/84/9) and after it (`output/final-targeted.txt:98-101`, 97/88/9) fail the same 9.

So the reviewer's criterion 4 pass stands: this evidence clears the failures as pre-existing and unrelated. Their root cause is outside this task (see follow-ups).

A full-suite run inside a `/tmp` copy was tried as a second baseline and discarded. Tests that shell out to `git` fail there (`fatal: not a git repository`), so its extra failures say nothing about this change.

## Follow-ups kept for relevance review (not filed)

- The 9 `voice-command-bar.test.ts` announcement and alert tests have been failing since at least `9f933ff` (2026-10-13). In the live-alert test no `/voice-prose` request is made (`0 !== 1`).
- Likely but **unverified**: on macOS, Option+Shift+V produces `key: "◊"`, so the `e.key.toLowerCase() === 'v'` match may never fire on a real Mac keyboard. Matching `e.code === 'KeyV'` as well would cover it. Headless CDP cannot reproduce OS layout mapping, so this needs a real keypress check.

## Files touched

- dashboard/src/components/bridge/voice-command-bar.tsx
- dashboard/src/components/global-voice-dock.tsx (already carried uncommitted task 1390fc34 hunks; my change is the wrapper class hunk only)
- dashboard/src/lib/__tests__/voice-dock.test.ts (already carried uncommitted task 1390fc34 hunks; my change is the appended test only)
- docs/reviews/2026-10-19-voice-pip-qa-improvements.md and docs/reviews/2026-10-19-voice-pip-qa-improvements/ (new evidence)
