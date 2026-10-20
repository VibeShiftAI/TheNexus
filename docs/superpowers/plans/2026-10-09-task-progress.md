# Task progress and readable history

Approved UI: current summary first, reported vs verified evidence, remaining QA, exact human request, then attempt-grouped chronological history. Preserve existing controls, deliverables and dossier.

Acceptance: newest attempt governs summary; old failures stay in history. Worker updates come only from explicit agent-message/text records, never reasoning/tool output. Reads are bounded, task scoped and readonly; unmatched log sections and unavailable/stale sources are named. Pending questions and recorded answers link to the existing inbox. No inferred retry cause or decision-to-run link.

Implementation: (1) tests and safe log projection/read-only endpoint; (2) tests and pure dashboard projection; (3) polling component with per-source availability, summary and expandable prior attempts; (4) focused server/dashboard tests, typecheck, isolated production build and browser review coordinated by parent.

Limits: logs may omit message timestamps; show their recorded sequence and run timestamp separately. A bounded log slice without its run boundary is unavailable, not current. HITL history is globally bounded by existing API, explicitly labeled. Requirements without structured completion evidence stay unknown.
