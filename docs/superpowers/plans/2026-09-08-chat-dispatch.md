# Chat-specific Dispatch activity and stable station layout

**Goal:** Show immediate send feedback, confirmed receipt, Praxis processing, reply streaming, completion, and failure in the center of the existing Dispatch graphic. Keep station geometry unchanged through work-state transitions.

**Design:** Preserve capacity/memory rings and give the central button to Praxis chat, with a separate capacity-details button below it. Use message/conversation-correlated relay telemetry, never executor or global presence state, to animate chat. A Sending state comes from the composer; Received follows server acceptance, Working follows Praxis opening its response stream, Replying follows response bytes, and terminal states follow actual completion/error. Non-streaming attachment/mobile requests remain Received while waiting because their transport provides no intermediate work signal. Clicking opens a receipt/status panel and the chat transcript.

**Sizing cause:** Browser measured Dispatch map rows as 100px,108px,108px,31px,0px at rest. The queue row is conditionally added; council seats wrap in an auto-height row; provider council captions are conditional; upcoming jobs also change row count. Reserve stable row sizes, scroll excess roster/queue content internally, and constrain ticker text. Animation changes only opacity/strokes inside fixed geometry.

- [x] Add regressions for correlated server lifecycle, failure/no false success, freshness, and no executor-to-chat leakage.
- [x] Add server relay snapshot/socket telemetry and immediate composer send signal; build chat center/details.
- [x] Reserve map, council, provider, queue, ticker, and scheduled-row space. Verify larger rosters remain accessible.
- [x] Run focused/full tests and isolated build; inspect idle/busy/queue/council fixtures at desktop and narrow widths with DOM measurements, and independent review. No live agent message is needed for verification.


**Verification:** 396 dashboard tests passed, including the real composer with a controlled response stream through Sending → Received → Working → Replying → Replied, interrupted streams, no per-token indicator rerenders, receipt attribution, and conversation isolation. All nine server chat suites passed (35 tests), including durable dedupe, mobile receipts, failure recovery with a duplicate message ID, and unsaved assistant history. The isolated `.next-chat-verify` production build passed compilation, TypeScript, and page generation; temporary generated tsconfig entries were removed.

**Browser evidence:** Original idle/busy Dispatch fixture grew from 413px to 534.5px (121.5px). Updated fixture remains 476px with a 410px map and the next panel at the same Y=544, at normal and 390px viewport widths. Seven executor providers produce 626px of content inside the fixed 410px viewport; the final provider remains clickable via internal scrolling. Council overflow also scrolls, with no horizontal page overflow. Chat receipt details and the capacity report links both work. Live dashboard shows a separate Ready chat center while Codex/Claude Code executors work, with a 590px Ops panel. No live agent messages were sent during verification. Preview route removed and browser viewport restored.

**Independent review:** Fixed a fresh-receipt clock flicker, failed-ID retry telemetry, and saved-history confirmation; reviewer confirmed no remaining blockers and independently reran the focused regressions. Reloaded the supervised Nexus API while its chat activity snapshot was empty; live dashboard and proxied activity endpoint verified.
