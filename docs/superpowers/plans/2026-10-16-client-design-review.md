# Client Design Review Implementation Plan

Approved by Robert's “proceed please” following the investigation and recommended integration.

**Goal:** Joey can view and review the new HWC designs through his existing project-scoped portal account.
**Architecture:** Keep the member/session entitlement boundary. Publish an immutable design package as a document artifact; expose a sanitized media descriptor and authenticated exact-version asset route. Extend the portal viewer and carry direction selection through the existing review queue into the append-only client ledger. Never grant dashboard/operator access. Existing dirty working trees contain the deployed client foundation; preserve them and capture per-file baselines.
**Tech stack:** Nexus Express/SQLite, Cloudflare Pages functions + browser JavaScript, Praxis TypeScript, shared Zod contract.

## Acceptance criteria
1. An entitled member can load published design screens and previews, select a direction, and submit version-bound feedback; selected direction survives the queue and ledger. Wrong project/member, revoked access, withdrawn/superseded artifact, stale version and expired session deny media/reviews. No filesystem paths, credentials, or operator-only content enter media descriptors.
2. The portal displays the approved HWC package on phone and desktop with safe HTML isolation, loaded-image evidence, clear error states, and exact-revision feedback controls. Existing Markdown reviews keep working. Security/regression tests and independent review pass before activation.
3. Deployed portal and Nexus serve the published package through real authenticated requests. Deliver a direct member review link; never fabricate Joey's acceptance.

## Tasks
- [x] Nexus: add tests first for sanitized design metadata, protected asset reads and selected-direction validation/replay; add backward-compatible selection storage and shared schema; use existing immutable blob storage for bytes.
- [x] Portal: tests first for entitlement/session/version/hash validation and selection queueing; add protected binary proxy, design gallery, sandboxed previews, selection and feedback controls; preserve normal text viewer.
- [x] Praxis: test selection forwarding through existing portal consumer, add typed field to queue and shared review request.
- [x] HWC: capture immutable screenshots and HTML exports in a client-facing `.design.json` package with 1a/1b/1c directions; omit internal evidence and account editor URLs.
- [x] Verify: focused Nexus/portal/Praxis tests, contract build, browser check, independent spec and security review. Keep test scratch/evidence on Projects.
- [x] Activate: normal managed Nexus/Praxis activation, targeted Pages deployment, register package and verify readiness, publish artifact, verify member route and assets without writing a client review, provide direct review link.

## Protocol details
GET client artifact returns existing artifact/content plus `media: {media_type, assets, directions}`. Assets contain only asset_key, role, media_type, mime_type, content_hash, byte_length, label, direction, appearance, viewport, state, before_asset_key, width, height, order. No raw manifest/path/source/evidence. Primary design manifest and evidence assets are not exposed. GET `.../artifacts/:artifactId/assets/:assetKey?version_hash=...` requires runtime credential, valid session assertion, current entitlement and artifact/version binding. Responses are private/no-store, nosniff, sandboxed for HTML/SVG.
Client review selection is `{direction: string}`; accepting a multi-direction package requires a valid declared direction. Selection participates in idempotency and cannot silently change an accepted direction. Legacy reviews keep original request hashes when selection is absent. Portal downloads use Bearer-authenticated fetch and local blob URLs, never session tokens in URLs; preview frames have sandbox without same-origin and restrictive embedded CSP. Revoke object URLs when views close/change.

## Delivery evidence
Published 2026-10-16. Joey’s existing entitlement can read the new artifact with 46 media assets; all 46 passed live authenticated hash verification and anonymous asset access returned 401. Browser verification uses Robert’s existing session and submits no production decisions. No client email sent.

Review: https://vibeshiftai.com/members/?project=05d25bcc-5dea-4720-8a08-e49ccecf0fa5&artifact=967de23c-1440-43ef-8552-684d9ce208c3

Evidence: `/Volumes/Projects/reviews/joey-design-access-2026-10-16/verification.json`. Portal deployment: `9051a960.vibeshiftai-com.pages.dev`. A report-theme import cycle in the concurrently committed backend was removed in Praxis `c960624`; boot check, typecheck and 29 report tests passed before managed activation.
