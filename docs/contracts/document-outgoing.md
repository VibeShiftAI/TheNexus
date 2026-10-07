# Exact outgoing document grants

Task c9658570, 2026-10-05. Nexus records review authority and durable delivery
state. Praxis prepares and sends messages. These API routes do not import or
invoke a delivery transport.

An editorial document decision, executor-recorded approval, comment, Finish
review, or task QA result **never authorizes sending**. A separate, explicit
`approve_send` binds the direct operator's decision to one outgoing version.

## API

All paths below are relative to `/api/documents/:id/outgoing`. Reads require
the normal authenticated document session. Runtime mutations require the
independently configured `NEXUS_STAKEHOLDER_RUNTIME_KEY` bearer credential.
Decisions use `createDocumentDecisionAuthority` and accept only `access_user`,
`access_device`, or `operator_credential`; the document executor credential is
refused. Cross-site browser decisions are refused.

| Method/path | Input | Response |
| --- | --- | --- |
| `GET /` | none | `{ outgoing: null }` or `{ outgoing: record }` |
| `PUT /` | preparation below | `{ outgoing }` |
| `POST /decision` | `{ decision: "approve_send" or "cancel", revision_id, envelope_hash }` | `{ outgoing }` |
| `POST /claim` | `{ revision_id, envelope_hash, delivery_id }` | `{ claimed: true or false, outgoing }` |
| `POST /receipt` | `{ delivery_id, status: "sent" or "uncertain", message_id? }` | `{ outgoing }` |
| `GET /history` | none | `{ history: event[] }` |

Preparation requires this exact shape; unknown fields fail closed:

```json
{
  "revision_id": "current captured revision",
  "envelope": {
    "to": "member@example.test",
    "cc": ["operator@example.test"],
    "subject": "Exact subject",
    "text": "Exact message body",
    "attachments": []
  },
  "provenance": {
    "member_id": "recipient identity",
    "project_id": "stakeholder project",
    "task_id": "originating task",
    "source_refs": ["source reference"],
    "commitment_id": "optional commitment identity"
  },
  "expected_envelope_hash": "required when replacing an existing version"
}
```

Recipients must be explicit email addresses, with no header control characters.
`cc` may be empty while a draft is held for missing operator configuration, but
an empty copy list cannot be approved. Only an empty attachment array is
supported. The envelope is stored verbatim; the sender must use that exact
snapshot and independently confirm its current recipient/copy policy before
claiming. It must never silently add recipients or replace reviewed text.

The document must be a declared deliverable with `requires_review: true` and
`intended_action: "send"`. Its task matches `provenance.task_id`. The producing
task may belong to a different project than the stakeholder: the outgoing
project matches `document.metadata.stakeholder_project_id`, when present,
otherwise `document.project_id`. A declared `metadata.member_id` must agree.
Commitment identity must match the document metadata, including absence. If
metadata declares `source_refs`, the outgoing selection must match exactly.
Member, project, task, and commitment identity cannot be reassigned. Source
references may change with a new version and a fresh grant.

## Versions, freshness, and cancellation

A byte-identical preparation retry returns the existing record unchanged.
Changes to the envelope, source references, or revision require the current
`expected_envelope_hash`. Every replacement creates a new opaque hash using
a unique nonce, even if A changes to B and later back to A. An old approval
or replacement request can never regain authority through identical bytes.
The logical `delivery_id` remains stable for this document.

The outgoing record includes the exact envelope and provenance, revision and
content hashes, status, nullable grant/receipt, timestamps, and persistent
`invalidated_at`/`invalidation_reason`. A grant snapshots the whole message,
provenance, revision, hash, delivery identifier, operator actor, authority,
and approval timestamp.

Capturing a different current revision through any document route revokes an
unclaimed grant. Observing an unavailable file also revokes it, including
failed registration attempts or producer hash mismatches. Returning the file
to its old bytes does not restore authority. The runtime must prepare a new
version using CAS, and the operator must approve again. Changes to document
identity, action, or stakeholder binding similarly revoke the grant.

Cancellation is permanent for the document and records the operator identity.
It requires the exact outgoing snapshot, but remains available if the source
file is missing or its revision has changed. A matching preparation retry may
observe `cancelled`; replacements and approvals cannot rearm it.

## One delivery and durable evidence

The lifecycle is `draft -> approved -> delivering -> sent|uncertain`, or
`draft|approved -> cancelled`. Revocation/replacement returns unclaimed work
to `draft`, with no grant. A claim commits `delivering` in SQLite before the
HTTP response. Exactly one concurrent caller receives `claimed: true`.
Every repeated claim of that version returns `claimed: false`, including
lost responses, restarts, and an uncertain result. There is no automatic retry
or state reset once claimed. The sender sends only after a successful claim.

Receipts require the matching delivery identifier and an existing claim.
Identical receipt retries are stable. Conflicting receipts are refused;
uncertainty cannot be rewritten into a new attempt. Edits after claim do not
change this durable delivery record.

`review_document_outgoing_events` is append-only, with SQLite update/delete
triggers. Preparation, approval, cancellation, invalidation, claim, and receipt
events retain their exact snapshots and actor/authority. Replacing the current
row never erases prior approvals or cancellation evidence.

The review page displays the exact envelope and sources beside explicit
**Approve and send** and **Cancel send** controls. Pending deliveries are
polled read-only until a final status appears. Authority, freshness, and
configuration errors remain visible; editorial controls remain separate.

## Verification

Use isolated project files and SQLite fixtures. Mock every delivery/provider
boundary and use the refusal preload before test imports:

```sh
NODE_OPTIONS='--require=/Volumes/Projects/Praxis/tests/fixtures/refuse-delivery-network.cjs' ./node_modules/.bin/jest server/__tests__/document-outgoing.test.js --runInBand
```

The UI test is `dashboard/src/components/__tests__/document-outgoing.test.mjs`.
No test requires a live approval, recipient, provider, fleet service, or data
migration. Existing cancelled logical drafts remain cancelled in Praxis.
