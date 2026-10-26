/**
 * Who may record a document review decision (Approve document / Request
 * changes). The legacy `local_user` stub the server stamps on every request is
 * not a credential: every local process, dispatched executors and the QA
 * reviewer included, reaches the documents API as that user. A decision
 * therefore needs one of the operator proofs Nexus trusts, or,
 * for an executor-recorded approval only, the document-scoped executor
 * credential, and nothing else:
 *
 *   access_user / access_device  a verified Cloudflare Access operator session
 *                                (operator-access.js): the tunnel browser, the
 *                                phone shell and the Windows travel shell.
 *   operator_credential          Robert's operator bearer credential
 *                                (NEXUS_OPERATOR_APPROVAL_KEY, checked by
 *                                stakeholder-authority.js) for a trusted
 *                                operator tool, or the short-lived local
 *                                session automatically issued by the server
 *                                after verifying the actual TCP peer's pinned
 *                                macOS app code and console UID. No extra login.
 *                                Enable NEXUS_LOCAL_OPERATOR_SESSIONS=1; pin
 *                                NEXUS_LOCAL_OPERATOR_UID and Chrome opt-in /
 *                                the hardened desktop build's CDHash. Signed
 *                                HttpOnly cookie + origin-stored random proof
 *                                header + active server state are all needed;
 *                                loopback/exact Origin only constrain use.
 *                                One-hour expiry; delete revokes one; restart
 *                                revokes all. Disable/rotate key or app pins
 *                                and restart to revoke and stop reissuance.
 *                                docs/contracts/local-operator-session.md.
 *   document_executor_credential the document-scoped executor credential
 *                                (NEXUS_DOCUMENT_APPROVAL_KEY, task a2553798):
 *                                a different key a dispatched executor uses
 *                                only to record Robert's own "approve with
 *                                changes" review on the resulting revision.
 *                                The documents route accepts it only with an
 *                                `executor` block citing a review Robert
 *                                finished with the approve-after-changes
 *                                grant (document-decision-provenance.js); it
 *                                can neither decide directly nor grant, and
 *                                stakeholder endpoints refuse it because they
 *                                ask stakeholder-authority.js for `operator`.
 *
 * Order matters. The session is checked first, whatever else the request
 * carries: the dashboard's shared fetch helper (dashboard/src/lib/auth.ts via
 * nexus/shared.ts) sends a placeholder `Authorization: Bearer local-dev-token`
 * with every call, so an Authorization header is not evidence of an operator
 * tool. Until 2026-10-04 the bearer was consulted first, which answered every
 * browser decision with 503 operator_credential_unconfigured (no key on the
 * host) or 403 (a key provisioned) and never inspected Robert's verified
 * session (task a1cc8616). The bearer path is consulted only for a request
 * with no verified session, and it still fails closed when unconfigured.
 *
 * Service users, bridge/executor headers, the runtime credential and an
 * unsigned local request are refused. The Mac app on localhost:3000 carries
 * no Access session; its native connection bootstraps the proof automatically.
 * Chrome's fixed proof policy verifies signatures/resources and strict symlinks
 * while permitting sideband metadata; the native app retains full strictness.
 * The shared verifier also gates chat restart authority. The ledger retains
 * operator_credential for a session signed by the operator authority, so existing
 * downstream operator-only allowlists and delegated-review checks still apply.
 */
const { createOperatorAuthenticator } = require('./operator-access');
const { requireStakeholderAuthority } = require('./stakeholder-authority');

function deny(status, code, error, extra = {}) {
    return { ok: false, status, code, error, ...extra };
}

function createDocumentDecisionAuthority({ authenticateOperator } = {}) {
    // Created on first use so booting the router adds no second set of
    // operator-access configuration warnings (ai-chat already reports them).
    let operator = authenticateOperator || null;

    return async function authorizeDecision(req) {
        if (!req.user?.id) return deny(401, 'authentication_required', 'Authentication required');
        if (req.user.is_service) return deny(403, 'operator_required', 'Service accounts cannot record document decisions');
        if (req.get('x-praxis-bridge-token') || req.get('cf-access-client-id') || req.get('cf-access-client-secret')) {
            return deny(403, 'operator_required', 'Executor and bridge credentials cannot record document decisions');
        }
        if (!operator) operator = createOperatorAuthenticator();
        let outcome = null;
        let checkFailed = false;
        try {
            outcome = await operator.inspect(req);
        } catch {
            checkFailed = true;
        }
        if (outcome?.operator) {
            const authority = outcome.identity === 'local' ? 'operator_credential'
                : outcome.identity === 'device' ? 'access_device' : 'access_user';
            return { ok: true, actor: { id: req.user.id, authority } };
        }
        // No verified session. A bearer, if one was sent, has to be the operator
        // credential or the document executor credential (a different key, so
        // the one never passes for the other); the refusal names what the
        // session check found so a client can tell "no Access session here"
        // from "wrong credential". A mismatched or unconfigured document
        // credential is reported as the operator refusal: the bearer is simply
        // not an operator proof.
        const reason = checkFailed ? 'check-unavailable' : (outcome?.reason || 'unknown');
        if (req.get('authorization')) {
            let operatorError;
            try {
                requireStakeholderAuthority(req, 'operator');
                return { ok: true, actor: { id: req.user.id, authority: 'operator_credential' } };
            } catch (err) {
                operatorError = err;
            }
            try {
                requireStakeholderAuthority(req, 'document_executor');
                return { ok: true, actor: { id: req.user.id, authority: 'document_executor_credential' } };
            } catch {
                // fall through to the operator refusal
            }
            return operatorError.status === 503
                ? deny(503, 'operator_credential_unconfigured', 'The operator credential is not configured; no decision can be recorded with it', { reason })
                : deny(403, 'operator_required', 'The supplied credential is neither Robert’s operator credential nor the document executor credential', { reason });
        }
        if (checkFailed) return deny(503, 'operator_check_unavailable', 'Operator identity could not be checked; no decision was recorded');
        return deny(403, 'operator_required',
            'Recording a document decision needs Robert’s verified operator session or operator credential; this request carries neither',
            { reason });
    };
}

module.exports = { createDocumentDecisionAuthority };
