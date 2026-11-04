# Consolidated inline review controls

Use superpowers:subagent-driven-development. User requests research and consolidated controls, and explicitly selected turning a comment into an editable suggestion before accepting it.

Research: Google Docs suggests exact changes with accept/reject and comments; Word distinguishes tracked edits from discussion threads and supports document-order review. NN/g recommends visible meaningful labels, consistent actions, and progressively disclosing secondary detail.
Sources:
- https://support.google.com/docs/answer/6033474?hl=en
- https://support.microsoft.com/en-us/word/accept-or-reject-tracked-changes-in-word
- https://support.microsoft.com/en-us/word/using-modern-comments-in-word
- https://www.nngroup.com/articles/ten-usability-heuristics/
- https://www.nngroup.com/articles/progressive-disclosure/

- [x] Single top action bar in existing comment card. Suggested edit: Accept, Edit & accept, Reject, Reply. No competing Resolve on suggestions. Accepted/rejected state with reversible Undo before apply. Document-order anchored cards; secondary rationale/original content disclosure, keep proposed text visible.
- [x] Comment without exact replacement: explicit Comment — no text change label; Reply, Turn into suggested edit, discussion resolution secondary. Passage conversion opens editor on exact anchor. Whole-document comment requires selecting a passage, never implicit whole-document replacement.
- [x] Operator-only conversion persists separately attributed proposal and choice, immutable original comment retained. Stable client_request_id retries, same base review for combined apply and overlap/stale checks. Empty replacement valid deletion. No automatic interpretation or application.
- [x] Regression tests cover one toolbar, note conversion, original authorship/prose unchanged, operator-only mutation, repeat lost response, stale refusal, overlap, empty replacement, draft recovery, correct ordering and Undo. Independent review, typecheck/build, activation, read-only live verification. Do not alter live review choices or source text as tests.

Verified: production build passed in `.next-review-controls`; focused server regression suites passed (63 tests, then 22 after retry uniqueness); dashboard regression suites passed (35 tests, with final conversion recovery cases re-run). Independent review found no blocking issues. Live supervisor restarted; v5 snapshot hash, all 17 findings and saved choices verified unchanged. Live browser shows consolidated actions in document order. Evidence: `/Volumes/Projects/outputs/document-review-2026-11-01/control-*`.
