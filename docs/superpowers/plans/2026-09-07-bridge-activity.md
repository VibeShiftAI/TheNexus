# Bridge activity and display sizing

Goal: extend the existing presence aesthetic to memory, vault writes, dispatch, work, QA, and completions; give each signal useful drill-downs; add a persistent master display scale.

Design: retain the dashboard layout and orb. Add six compact activity tiles with colored orbits and bounded event pulses. One shared provider combines the existing live stream/run snapshot with a five-second cached read-only knowledge endpoint. Memory means recorded MCP retrievals; vault modifications come from authored Markdown mtimes (latest write per file, not a complete write audit). No activity is fabricated. QA run completion must never claim QA pass. Empty, disconnected, stale, and failed signals remain distinct.

Drill-down: tile → filtered activity dialog → selected event detail → original task/QA evidence, knowledge console, or full vault document. Provide a full Activity report page. Existing core vitals, council, thought trace, and bottom log gain links/details. Reuse existing panels and routes.

Display: one master text and UI scale (80–150%, 5% steps), device/browser-local persistence, accessible minus/plus/reset and presets. Scale the entire body including fixed-pixel labels, canvas/SVG, portals, and existing inbox controls. Keep an always-available control beside the footer ticker. Preserve current default at 100%.

Acceptance:
1. Real memory/vault events appear with timestamps and drill-downs; task and QA activity retain correct owner links; pulses expire and unavailable sources do not claim idle/live work.
2. Master scale affects fixed-pixel labels and existing panels, persists on reload/navigation, and supports keyboard use and reset at laptop/large monitor sizes.
3. Relevant server/dashboard tests and an isolated production build pass; exercise affected controls and routes in the browser.

Implementation:
- [x] Add read-only knowledge snapshot/document routes with tests for successful reads, partial availability, bounded queries, traversal and symlink refusal.
- [x] Add pure activity derivation with tests for classification, deduplication, staleness, terminal state, QA ownership, and failure semantics.
- [x] Add one shared activity provider, tiles, details, report page, and integrate core/ticker/knowledge links.
- [x] Add persistent master display provider/control and verify keyboard/persistence/bounds.
- [x] Build, drive UI at two viewports, review scoped diff, record limitations and results.

Existing uncommitted work is present in this checkout; preserve it, avoid bulk staging/commits, and make only targeted integration edits.

Verification completed:
- Dashboard test suite: 201 tests passed. Knowledge API suite: five tests passed.
- TypeScript check and isolated production build passed, including the activity report route.
- Independent review findings were fixed and 13 focused checks passed on re-review.
- Browser checks exercised real MCP memory activity, vault tile → detail → full Markdown report, QA task → anchored verdict, keyboard sizing, persistence, and reset.
- Layout fits 1920×1080 at 125% and 1366×768 at 90%; a long activity dialog fits the laptop viewport at 150%.
- Running development dashboard and restarted API serve the changes. Existing unrelated work was preserved; no commit or push.

Reporting limits: knowledge refreshes every five seconds; memory activity reflects recorded MCP calls, while vault activity reflects the latest authored Markdown modification per file. The activity report is a bounded recent view, with original task pages retaining full execution and QA evidence.
