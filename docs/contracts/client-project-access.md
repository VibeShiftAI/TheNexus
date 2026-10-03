# Client project access and version reviews, contract revision 1.1

**FOUNDATION ONLY.** This document and the code it describes are the Nexus
foundation for client project access, delivered by task
`0d8f392f-33f4-4e2c-8ccf-5ef7759e679f`. On their own they give no client
working access to anything. Everything a client actually touches is owned by
successor task `96eaa517-9de9-4f89-b666-623313a91fbe`: the Praxis relay
consumer, the public vibeshiftai portal project view and review controls,
email integration, live activation of the Nexus routes, fail-closed public
revocation against retained snapshots, and the independent end-to-end
verification of a real member round trip. See "Successor ownership" below. No
working full-access claim is valid until that successor passes its retained
live criteria; this foundation reports Joey's access as pending.

Robert's October 2, 2026 authorization is recorded at
`/Volumes/Projects/shared-mind/memories/feedback_joey_lautrup_client_workflow_2026-10-02.md`:
Joey Lautrup (member `cb182cba-5d14-4c71-b0a8-eaee91edf359`) has full access to
his own project (`05d25bcc-5dea-4720-8a08-e49ccecf0fa5`, Joey Lautrup Health
Tracking App): requirements, tasks, deliverables, code/preview links, decisions,
feedback and progress. It is project-scoped access, never other clients' data,
global Nexus administration or operator credentials. The same note says the
existing portal is limited and that full access must not be claimed operational
until implemented and verified; this contract is the Nexus-owned half of that
implementation. The delivery split is recorded in
`/Volumes/Projects/reviews/joey-client-setup-2026-10-02/delivery-scope-amendment.md`.

Shapes live in `@praxis/contract` (`/Volumes/Projects/nexus-shared/src/entities/client-access.ts`),
the ledger in `db/client-access.js`, the routes in
`server/routes/client-access.js`, the local grant path in
`server/scripts/grant-client-access.js`, the cockpit panel in
`dashboard/src/components/project-client-access.tsx`, and the tests in
`server/__tests__/client-access.test.js`.

## What this foundation delivers

- An explicit, immutable, project-scoped entitlement ledger with revocation
  and live resolution on every request.
- Client-safe projections of a project's requirements, checkpoint plan, task
  progress, published artifact versions, decisions and feedback, built from
  allowlisted fields only.
- Immutable artifact versions (`version_hash`) and an append-only review
  ledger that binds an acceptance to the authenticated member, the project,
  the exact version and the asserted portal session, with reserved decision
  keys for replay safety.
- Runtime-only client routes and operator-only grant/revoke routes, with one
  uniform denial on the client surface.
- Shared zod contract (revision 1.1), synthetic server and dashboard tests,
  a local grant script, and Joey's recorded entitlement
  (`26f7e065-e039-46b8-8a6c-2f9d5f0b14fb`, `authority: operator_local`, source
  = the memory note above). That receipt proves the grant is recorded; it is
  not proof of a working portal.

## Contract revision 1.1 (2026-10-02 QA repair)

Changes from revision 1.0, all enforced by the server and expressed in the
contract:

- **Links.** A client receives only credential-free absolute http(s) URLs.
  Project `urls` values are filtered on projection (anything else is dropped
  silently), publication refuses anything else with 400 `unsafe_url`, and a
  stored artifact link is re-checked on every read (an unsafe stored value
  projects as `null`). `ClientSafeUrlSchema` is the contract form;
  `ClientArtifactSchema.url`, workspace `project.urls` and
  `ClientArtifactPublishSchema.url` use it.
- **Decision keys.** Every acknowledged `client_decision_id` is reserved in the
  new `client_review_keys` table against the payload it answered, including a
  key that resolved to an existing acceptance without writing a new review.
  An identical replay returns the same review; any other reuse is 409
  `decision_conflict`.
- **Publish retries.** An identical publish is recognized before any
  supersession rule can reject it: the same identity that is already current
  returns that artifact with `duplicate: true` even when it names
  `supersedes_id`. A different version claiming an already-superseded
  predecessor is still 409 `artifact_already_superseded`; the same identity
  naming a different predecessor is 409 `publish_conflict`.
- **Fail-closed lookups.** Nothing is ever authorized from stored state. When
  the entitlement lookup itself cannot run, every client operation answers
  503 `entitlement_unavailable` with no project content.
- **Contract additions.** `CLIENT_ACCESS_CONTRACT_REVISION` (`"1.1"`),
  `ClientSafeUrlSchema`, `CLIENT_ACCESS_ERROR_CODES`,
  `ClientAccessErrorCodeSchema`, `ClientAccessErrorSchema`.

## What an entitlement is

An entitlement is one immutable row binding one member to one project with
scope `client_project`. It is honored only while all of the following hold,
re-checked on every request:

- the member exists and is not dormant;
- the member is still linked to that project (`project_contacts`), so
  unlinking the member removes access;
- the member's name and email still match the snapshot taken at grant time
  (an identity edit requires a fresh grant, which closes the stale one in the
  ledger with reason `identity_changed_regrant`);
- no `revoked` event exists for the entitlement.

The decision-maker flag, a project link, a portal session or `req.user` never
grant access on their own. An entitlement grants nothing beyond its one
project and conveys no operator, administrative, task-control or credential
rights: the client surface cannot reach tasks of another project, the board
APIs, stakeholder decisions, write leases, model controls or any credential.

Nothing stored authorizes access. The member snapshot inside an entitlement is
a binding to check against, never a source of truth; the ledger holds no
cached projection; and a lookup that cannot run denies. The same rule binds
every consumer: a retained relay feed, R2 object, pushed workspace or portal
cache can never stand in for a current answer from these routes.

## Authority

- **Grant and revoke** require Robert's operator credential
  (`Authorization: Bearer <NEXUS_OPERATOR_APPROVAL_KEY>`, the same rule as
  reserved stakeholder decisions). Missing or short keys fail closed with 503,
  a wrong key or the bridge header with 403, and the runtime credential is
  refused. That key is not provisioned on the live server as of 2026-10-02, so
  the equivalent local path is `node server/scripts/grant-client-access.js`
  run on the Nexus host (filesystem access to `nexus.db` is already
  operator-level access). It writes the same ledger rows with
  `authority: operator_local` and the recorded authorization source.
- **The client surface** (`/api/client-access/...`) accepts only the trusted
  runtime credential (`NEXUS_STAKEHOLDER_RUNTIME_KEY`, which Praxis already
  holds for stakeholder receipts). The cockpit `req.user` stub, the operator
  key, member status and the bridge header are all refused. Nexus has no
  client credential of its own: the runtime resolves the member from the
  member's own authenticated portal session (relay `requireSession`:
  Bearer `pt_...` token to `memberId`) and then acts for that member id. The
  member id in the path is honored only under the runtime credential and never
  from a query parameter, a claimed name or an email.
- **Publishing and withdrawing artifacts** accept the runtime or the operator
  credential.
- **The cockpit summary** (`GET /api/projects/:id/client-access`) is an
  ordinary cockpit read.

## Session assertion

For every client review the runtime must send the session it verified:

```
x-client-session-sha256: <sha256 hex of the portal session token>
x-client-session-expires: <ISO expiry of that session>
```

A missing assertion is 401 `session_required`, a malformed one 401
`session_invalid`, an expired one 401 `session_expired`. The hash and expiry
are stored with the review and shown only in the cockpit summary, never in
client responses. Reads accept the same headers optionally and echo only the
expiry; a runtime building a projection for the relay may read without them
but must serve the result only behind that member's authenticated session, and
only for as long as these routes keep answering 200 for that member.

## Endpoints

Client surface, mounted at `/api/client-access` (runtime credential):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/members/:memberId/projects` | `ClientProjectList`: only projects the member is entitled to right now |
| GET | `/members/:memberId/projects/:projectId` | `ClientProjectWorkspace` |
| GET | `/members/:memberId/projects/:projectId/artifacts/:artifactId` | `ClientArtifactDetail` (captured document content for `document` kinds) |
| POST | `/members/:memberId/projects/:projectId/artifacts/:artifactId/reviews` | `ClientReviewResponse`, 201 new or 200 replay |

Every denial on this surface is the same body regardless of cause:
`403 {"error":"Project access is not granted","code":"not_entitled"}`.
Another member, another project, an unknown project, an unknown member, a
revoked, unlinked, dormant or renamed member, and a decision maker without an
entitlement are indistinguishable. A lookup that cannot run is
`503 {"error":"Entitlement lookup unavailable; project access is denied","code":"entitlement_unavailable"}`.
Both mean "stop serving this project to this member now".

Operator surface, mounted at `/api/projects`:

| Method | Path | Authority |
| --- | --- | --- |
| GET | `/:id/client-access` | cockpit read: entitlements with live `access` resolution, artifacts, reviews with session hashes |
| POST | `/:id/client-access/entitlements` `{member_id, source?, note?}` | operator credential; 409 if the member is not linked or is dormant; duplicate grant returns 200 |
| POST | `/:id/client-access/entitlements/:entitlementId/revoke` `{reason?}` | operator credential; idempotent |
| POST | `/:id/client-access/artifacts` (`ClientArtifactPublish`) | runtime or operator credential; 200 on an identical retry |
| POST | `/:id/client-access/artifacts/:artifactId/withdraw` `{reason?}` | runtime or operator credential; idempotent |

Error codes (`CLIENT_ACCESS_ERROR_CODES`): `not_entitled`,
`entitlement_unavailable`, `session_required`, `session_invalid`,
`session_expired`, `artifact_not_found`, `version_mismatch`,
`artifact_not_current`, `already_accepted`, `decision_conflict`, `unsafe_url`,
`publish_conflict`, `artifact_already_superseded`,
`document_project_mismatch`, `document_revision_missing`,
`document_revision_mismatch`.

## What the workspace contains, and what it never contains

`ClientProjectWorkspace` carries: the member's own identity and role; the
project's name, description, status and `urls.production|repo|docs` (only
credential-free http(s) values survive); requirements (`end_state`, end-state
criteria, information needs with their question and satisfaction test); the
checkpoint plan with the current checkpoint, statuses and criteria; task
progress (id, name, status, priority, dates, an optional steward-written
`metadata.client_summary`, and the stakeholder-gate status for client
requests); published artifacts with their reviews; `decisions` (accept
reviews) and `feedback` (comments and change requests).

It never carries task descriptions, dispatch instructions, executor payloads,
walkthroughs, model or executor assignments, task metadata, project
`comms_settings`, `report_template`, filesystem paths, information-need
notes, checkpoint assessments or history, document registry paths, other
projects, a `javascript:`, `file:` or credential-bearing link, or any
credential. The projection is built from allowlisted fields only; new server
fields do not leak by default.

## Artifacts and version binding

An artifact is an immutable published version of kind `document` (a captured
`review_documents` revision, which must belong to the same project),
`preview` or `code` (a credential-free absolute http(s) URL plus a `version`
label) or `deliverable` (a `version` label, optional URL under the same
rule). `version_hash` is the sha256 of the canonical identity (`project_id,
kind, title, version, url, document_id, revision_id, content_hash`), so the
same content is one version and any change is a different one. Publishing the
same identity again returns the existing current artifact with
`duplicate: true`, before any supersession rule is applied. A new artifact
may name `supersedes_id`; the older one becomes `superseded`, and a later
different version naming the same predecessor is refused
(`artifact_already_superseded`). Withdrawing marks an artifact `withdrawn`.
Only `current` artifacts accept new reviews.

## Reviews and acceptance

`decision` is `comment`, `request_changes` or `accept`. Each review names a
`client_decision_id` chosen by the caller (the portal queue id), the exact
`version_hash`, and for comments or change requests a non-empty body.

- Every acknowledged `client_decision_id` is reserved against the payload it
  answered. A replay with the same id and payload returns the stored review
  with `duplicate: true` (even after the version was superseded); the same id
  with any other payload is 409 `decision_conflict`. A key acknowledged for a
  second `accept` of an already-accepted version is reserved against the
  original acceptance exactly like a key that wrote a row.
- `version_hash` must equal the artifact's current hash (409
  `version_mismatch`), and the artifact must be `current` (409
  `artifact_not_current`).
- Acceptance is final per member and version: a second accept returns the
  original acceptance, and `request_changes` after an accept is 409
  `already_accepted` (publish a new version to reopen review). Comments remain
  open.
- Each review stores the member identity snapshot, the session hash and
  expiry, and the runtime authority; `evidence_ref` is
  `nexus:client-review:<id>`.
- A review under a revoked, unlinked, dormant or renamed membership is denied
  before any replay lookup: revocation ends replays too.

Acceptance is a client decision, not technical QA, a document-review comment
or any of Robert's reserved decisions. It changes no task status, checkpoint,
gate, proposal or write lease. The steward (Praxis) cites `evidence_ref` as
the dated passing observation of the matching manual checkpoint criterion
(for example `joey-prototype-acceptance`) through the existing checkpoint
transition endpoint; that transition keeps its own revision guard and
evidence rules. "Finish review" on a document, a comment, or link
availability are never acceptance. Robert's scope, capability, spending and
release decisions stay on their existing surfaces.

## Successor ownership: task 96eaa517-9de9-4f89-b666-623313a91fbe

The successor owns all of the following, in full, under its own write leases,
QA and live verification. None of it is delivered, started or implied by this
foundation.

1. **Relay consumer (Praxis).** For each entitled member, read the workspace
   with the runtime credential and push it to the relay as the member's
   project view (for example `portal/members/<memberId>/project/<projectId>.json`);
   publish preview and document versions through the operator surface; poll
   the relay review queue; resolve the member from the queued item's session
   (`memberId` comes from `requireSession`, never from the item body); post
   each decision with the session assertion headers and the queue id as
   `client_decision_id`; on `accept`, record the checkpoint observation with
   the returned `evidence_ref`.
2. **Public UI (vibeshiftai members portal).** Render the pushed workspace and
   queue reviews through the existing session-bound edit path. The portal
   sends the artifact id and `version_hash` it displayed; a stale view
   receives `version_mismatch` and must refresh.
3. **Email integration.** Approved-lead intake, project-scoped automatic
   questions, version-bound review routing, follow-ups and capability
   escalation, retaining query `hq_mur1ewn1_3amoh4` / PX-GEN-18 without
   resending it.
4. **Fail-closed public revocation.** On every public project, feed, task,
   document, artifact, preview, code-link, feedback and review read or write,
   check the current member and project entitlement through these routes and
   fail closed when the answer is `not_entitled`, `entitlement_unavailable`,
   a transport failure, an expired session or anything uncertain. A stored
   snapshot, pushed workspace, retained feed or R2 object never confers
   access; an entitlement lookup failure denies. Rerun
   `/Volumes/Projects/reviews/joey-client-setup-2026-10-02/portal-revocation-probe.mjs`:
   an obsolete stored feed must be denied without leaking its content,
   including the lookup-failure and post-restart cases.
5. **Live activation.** Reload the Nexus API so the routes mount, deploy the
   Praxis consumer and the portal through their normal gates, and confirm each
   runtime serves the tested revision. This foundation restarted nothing.
6. **Independent end-to-end verification.** A real Joey session round trip
   through the existing identity channel covering requirements, task
   progress, real available deliverables and links, feedback and exact-version
   review, with no invented app content, fake acceptance or forged session,
   followed by cross-executor QA against the released source.

## Deployment and consumer steps

1. **Shared contract.** In `/Volumes/Projects/nexus-shared`: `npm run typecheck`
   and `npm run build`; the root Nexus server resolves the package from that
   checkout (symlink), so the rebuilt `dist/` is live for it immediately.
2. **Dashboard copy.** In `dashboard/`: `rm -rf node_modules/@praxis && npm install`
   (the dashboard installs the contract as a real copy; a plain install does
   not refresh it). Done for revision 1.1 on 2026-10-02.
3. **Praxis.** Install the rebuilt contract the same way Praxis already
   consumes `@praxis/contract`, assert `CLIENT_ACCESS_CONTRACT_REVISION === "1.1"`
   at startup of the consumer, and treat every code in
   `CLIENT_ACCESS_ERROR_CODES` as documented above.
4. **Nexus API reload.** The supervised `:4000` process mounts the routes only
   after a reload; the successor coordinates that through the ordinary Praxis
   supervisor gate.
5. **Entitlement.** Joey's grant already exists; a repeated
   `node server/scripts/grant-client-access.js --project 05d25bcc-5dea-4720-8a08-e49ccecf0fa5 --member cb182cba-5d14-4c71-b0a8-eaee91edf359 --source <ref>`
   is idempotent and returns `duplicate: true`; `--show` prints the live
   resolution.
6. **Probes and QA.** Rerun the portal revocation probe and the successor's
   own regressions, then independent cross-executor QA, then the real member
   round trip.

## Status (2026-10-02, after the QA repair round)

Delivered here: the ledger (now including `client_review_keys`), routes,
contract revision 1.1, synthetic tests, the local grant script and the cockpit
panel. Joey's entitlement is recorded on the live `nexus.db`. The live Nexus
API process has not been reloaded by this task, so the routes are not yet
mounted on `:4000`; the Praxis consumer, the portal view and email integration
do not exist yet; no member session has exercised any of this. Live portal
access is pending, not verified, and must be reported that way until the
successor's real member-session round trip succeeds.
