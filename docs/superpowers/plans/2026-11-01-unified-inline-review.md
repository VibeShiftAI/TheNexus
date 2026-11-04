# Unified inline review and editorial draft numbering

Use superpowers:subagent-driven-development for bounded implementation and independent review. User explicitly requests correcting the previous feature: reuse existing inline comments, add accept/edit/reject suggestions there, remove separate executor panel, migrate existing v5 findings, count delivered drafts rather than intermediate captures.

- [x] Versioning: inspect capture/registration/readiness and history; persist review-draft identity separately from immutable snapshot IDs. Group intermediate captures by replacement/delivery; respect explicit document draft labels when valid. Existing history and anchors remain accessible, regular review selector lists delivered drafts. Backfill this document from exact snapshots and completed replacement evidence. Test intermediate writes, delivery, retries and history.
- [x] Inline data: reuse document_review_comments and existing anchor/author/reply/resolution semantics; extend with attributed suggestion provenance and decisions. Idempotent migration of existing agent findings, preserving originals, IDs/provenance and choices. Capability submissions feed unified comments; keep existing immutable assignment/apply safeguards. No live migration until tested.
- [x] UI: remove separate AgentReviewPanel; integrate findings in existing comment list, passage counts/anchors/jump behavior. Accept/reject/edit suggestion controls on existing comment cards, combined apply with stale/overlap protections; retain draft recovery and typing performance. Test this surface, no duplicate presentation.
- [x] Integrate, independent review, isolated end-to-end test; typecheck/build and focused regression suites. Snapshot live v5 records, run idempotent targeted migration, verify exact count/content/anchors without applying any suggested edits. Activate and read-only smoke check.

Reuse dirty checkouts, preserve unrelated changes. Agents own separate areas and coordinate shared-file changes. Runtime APIs may retain backward-compatible assignment transport but no separate commenting workflow for future executor reviews. No publication, no new live review task, no automatic acceptance of suggestions.

## Verification evidence

- Final server document run: 13 suites / 194 tests pass.
- Existing document review, draft recovery, latest-version tests: 33 pass; separate inline UI and composition tests: 2 pass. Worker broader UI runs and isolated Next production build/typecheck passed.
- Praxis notification and revision lifecycle: 32 tests pass; operator replies on executor comments and suggestions retain holds without treating executor prose as user intent. Typecheck passed.
- Cross-service isolated notification/assignment/read/submit/apply integration passed with zero chat messages.
- Full consistent pre-migration database backup and scoped records saved under `/Volumes/Projects/outputs/document-review-2026-11-01/`. Real-data migration tested on a copy, then applied live with the same verifier: 6 comments + 11 suggestions, unchanged choices/source/snapshots, repeat migration no-op, draft history v1-v5. Live evidence: `unified-live-migration.log`.

- Activated via documented Praxis LaunchAgent restart. Live API confirms v5, 17 inline findings, 11 suggestions attributed Claude, delivered drafts [1,2,3,4,5], all9 snapshots. Dashboard HTTP200. Browser verified v5 badge, existing comment cards and accept/reject/edit controls; clicking a suggestion selects its passage. No live choices/replies/application were changed during verification.
