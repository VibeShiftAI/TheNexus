# Praxis Mail Drafts Implementation Plan

Goal: make Praxis Mail the complete operator review surface for all drafted email.
Architecture: retain document outgoing and human-query durable stores, expose both through one Drafts/Cancelled UI, preserve exact authority and one-shot claims.
Tech stack: Express/SQLite, TypeScript runtime, React/Next.

- [x] Inventory drafting producers and actual runtime data locations; record counts without exposing bodies.
- [x] Extend document outgoing store/routes: list mail drafts with project/task context; operator-only edit with CAS and append-only provenance; return-to-Praxis hold. Exclude prepared mail from default document lists/counts. Tests cover stale edits, forbidden authorities, cancellation permanence, feedback hold, counts.
- [x] Extend runtime query drafts: dedicated draft review version, same-origin operator proxy actions, edit/return/cancel/approve, immutable claim and exact envelope, no legacy HITL release for migrated rows. Tests use isolated stores and refused transport.
- [x] Build unified Drafts and Cancelled UI with counts, editor, feedback, context, status and polling. Existing document feedback submission delivers comments; no comment authorizes send.
- [x] Reconcile operator-edited document envelopes with reply binding only with trusted operator edit provenance and original binding equality. Preserve trace tags and source identity. Update producer links/instructions to Mail.
- [x] Activate and migrate idempotently without sending; preserve existing records/history and quarantine incomplete drafts visibly.
- [x] Run targeted server/runtime/UI regression tests, type checks, independent review, inspect live counts and browser workflows with no real approval/send.
