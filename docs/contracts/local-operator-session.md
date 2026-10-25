# Local operator session

Task: `5f15ca0f-17b1-48a7-aa93-61f212fcabf6`.

Robert can explicitly sign in at `http://localhost:3000/operator-sign-in`, or
use **Operator sign-in** in Praxis Mail and the document decision card. The
inline dialog preserves the underlying review and unsaved fields. Sign in
separately in the Mac Tauri webview and the local browser: their cookie stores
are independent. The Mac shell needs no embedded secret or native rebuild.
The Windows shell, phone and tunnel continue using Cloudflare Access.

## Proof and boundary

Sign-in exchanges Robert's existing `NEXUS_OPERATOR_APPROVAL_KEY` for a random
256-bit session identifier authenticated by HMAC-SHA256 with that key and the
domain separator `nexus-local-operator/v1`. The server retains only the hash
of the token and its expiry, in process memory. Both a valid signature and a
live server entry are mandatory. The session expires after one hour; reads
and decisions do not extend it. Sign-in replaces the current cookie/session.

The cookie `nexus_local_operator` is HttpOnly, SameSite=Strict, host-only and
scoped to `/api`. It has no Secure attribute because the existing Mac shell
uses HTTP localhost. It must never be deployed as a remote HTTP session.
Browser cookies are not port-isolated: other applications on localhost are
part of the host's security boundary. Protect the operator credential, the
browser profile and the trusted dashboard code from executor access. This is
credential authentication, not attestation of a process's executable or OS
identity; anyone stealing Robert's credential or session can impersonate him.
The feature does not claim to defend a compromised browser or same-user
process with unrestricted access to its profile, memory or UI automation.

Every session use needs a direct loopback socket and the exact Origin
`http://localhost:3000`. Only GET/HEAD may substitute a Referer with that
origin when the browser omits Origin. Forwarded IP/origin headers are never
proof. Non-same-origin Fetch Metadata, service users, bridge headers and
Cloudflare service-token headers are rejected. A plain loopback request,
`local_user`, an executor/QA label, placeholder bearer or runtime credential
cannot mint a session. Sign-in has a shared ten-attempts-per-minute limiter
and the store holds at most 64 sessions. The credential is submitted in an
Authorization header, never a URL, document, chat, log, localStorage or
sessionStorage. Password input clears before the response is awaited.

Cloudflare assertions retain precedence and their existing verification
rules. Local cookies are checked only when no Access assertion is present.
Invalid local proofs return fixed `claim-rejected` / `local-session`
diagnostics, never token material. Requests without local cookies retain
their prior refusal categories.

## Provisioning

1. The operator provisions `NEXUS_OPERATOR_APPROVAL_KEY` in the server's
   existing protected environment. It must have at least 32 characters and
   differ from `NEXUS_STAKEHOLDER_RUNTIME_KEY` and `NEXUS_DOCUMENT_APPROVAL_KEY`.
   Do not give it to executors, put it in the desktop binary, or publish it in
   a task. This feature does not read a secret file on the client's behalf.
2. Set `NEXUS_LOCAL_OPERATOR_SESSIONS=1` in the Nexus server environment and
   restart the supervised Nexus API. Missing/disabled flag or a missing,
   short or colliding operator key fails closed. No flag defaults to enabled.
3. Robert opens the local sign-in dialog and enters his credential himself.
   A successful response sets the HttpOnly cookie. Close the dialog and make
   the intended decision; sign-in never retries a decision or sends mail.
   Following a mail error, refresh and inspect its current state before acting.
4. Repeat sign-in in each independently used browser/webview. The ordinary
   dashboard `/api/*` proxy conveys the cookie; no second backend URL is used.

## Revocation

- **Sign out** deletes the server entry and clears the current cookie. A
  copied token is also invalid after logout. Other sessions are unaffected.
- Restart the Nexus API to revoke all sessions. A token is never restored
  from disk after restart.
- Disable `NEXUS_LOCAL_OPERATOR_SESSIONS`, or remove/rotate the operator key,
  then restart the supervised API to revoke all sessions and enforce the new
  configuration. Rotation also revokes direct uses of the old operator key.
- Sessions expire after one hour even if the client retains its cookie.

## Authority and wire contract

`POST /api/operator-session` uses the operator bearer and returns 201 with
`{operator:true, expiresAt:<epoch milliseconds>}` plus Set-Cookie. Refusals
use 403 `operator_required` or 503 `operator_credential_unconfigured`; the
rate limiter uses 429. `GET` returns only status/expiry, never proof material.
`DELETE` revokes the current session and returns `{operator:false}`.
Responses are `Cache-Control: no-store`.

`operator-access.js` reports identity `local`. Document decisions and edits
record the existing `operator_credential` authority because the session was
explicitly established with that credential, and retain the existing
`local_user` actor id used for Robert's dashboard reviews. `recorded_by` is
`operator`, never `executor`. This preserves existing downstream authority
allowlists, outgoing-message grants and approve-after-changes delegation.
The session itself does not broaden the separate stakeholder bearer API.

Praxis Mail still receives the exact body-bound signed `mail-drafts` surface
and records `operator:mail-drafts`. The shared chat authenticator recognizes
the same proof before signing existing chat provenance surfaces; it cannot
turn an unsigned executor chat into an operator turn. `PRAXIS_OPERATOR_KEY`
remains a separate server-to-runtime relay credential. No Praxis code change
is needed for this session mechanism.

## Verification

Run `npx jest server/__tests__/local-operator-session.test.js
server/__tests__/local-operator-flows.test.js --runInBand` for expiry,
revocation, wrong credentials/origins, signature tampering, document ledger
decisions and signed mail relay tests. Existing document-deliverables,
document-executor-approvals, document-outgoing, mail-draft-auth-mount,
mail-draft-relay, praxis-operator-provenance and client-access tests cover
the unchanged Access and stakeholder boundaries. Synthetic relay checks do
not claim that real mail was delivered or that Robert signed into his app.

Dashboard verification also requires a build and running-browser exercise,
per `docs/verification-protocol.md`. Real operator activation requires
Robert's own sign-in; an executor must never fetch his secret or manufacture
that live evidence.
