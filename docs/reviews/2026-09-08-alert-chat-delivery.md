# Praxis announcement and failure delivery

User report: the voice panel and red failure ticker had no corresponding saved chat/inbox record.

Findings: VoiceCommandBar composed and played alert prose without archiving it. Praxis exported startOperationalEventBridge but never called it at startup. The ticker treats task.failed as red, whereas its operational mapping was warning and did not invoke the critical-alert inbox path.

Changes: archive exact announcement prose as one assistant message before playback; stable event ID, captured conversation, receipt merge, and suppressed chat autoplay. Start the operational bridge after HITL initialization. Each mapped task failure creates/reuses the existing persisted red-alert acknowledgment item and publishes a chat notice linking to it. QA review lifecycle events remain excluded. No historic failure replay (the screenshot task subsequently passed QA).

Verification: dashboard focused suites 31 tests passed; Praxis ops/alert suites 16 passed plus expanded real-bus delivery suite 3 passed. Real-bus test exercises inbox persistence, chat deep link and pending-incident dedupe without a browser. Praxis typecheck clean; isolated dashboard production build passed. Independent review found no material defects. Restarted com.praxis.bot and confirmed Operational event bridge attached in live log; live chat and stream snapshot endpoints returned HTTP 200. Dashboard rendered; browser live-state UI remained reconnecting in the background test tab, so no live synthetic voice/failure event was claimed or injected.
