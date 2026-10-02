/**
 * Who may record a document review decision (Approve document / Request
 * changes). The legacy `local_user` stub the server stamps on every request is
 * not a credential: every local process, dispatched executors and the QA
 * reviewer included, reaches the documents API as that user. A decision
 * therefore needs one of the two operator proofs Nexus already trusts, and
 * nothing else:
 *
 *   access_user / access_device  a verified Cloudflare Access operator session
 *                                (operator-access.js): the tunnel browser, the
 *                                phone shell and the Windows travel shell.
 *   operator_credential          Robert's operator bearer credential
 *                                (NEXUS_OPERATOR_APPROVAL_KEY, checked by
 *                                stakeholder-authority.js) for a trusted
 *                                operator tool.
 *
 * Service users, bridge/executor headers, the runtime credential and an
 * unsigned local request are refused, and an unconfigured authority fails
 * closed. The Mac app on localhost:3000 carries no Access session, so it can
 * read and comment but cannot decide; that is the same rule the chat restart
 * authority follows.
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
        if (req.get('authorization')) {
            try {
                requireStakeholderAuthority(req, 'operator');
                return { ok: true, actor: { id: req.user.id, authority: 'operator_credential' } };
            } catch (err) {
                return err.status === 503
                    ? deny(503, 'operator_credential_unconfigured', 'The operator credential is not configured; no decision can be recorded with it')
                    : deny(403, 'operator_required', 'The supplied credential is not Robert’s operator credential');
            }
        }
        if (!operator) operator = createOperatorAuthenticator();
        let outcome;
        try {
            outcome = await operator.inspect(req);
        } catch {
            return deny(503, 'operator_check_unavailable', 'Operator identity could not be checked; no decision was recorded');
        }
        if (outcome?.operator) {
            return { ok: true, actor: { id: req.user.id, authority: outcome.identity === 'device' ? 'access_device' : 'access_user' } };
        }
        return deny(403, 'operator_required',
            'Recording a document decision needs Robert’s verified operator session or operator credential; this request carries neither',
            { reason: outcome?.reason || 'unknown' });
    };
}

module.exports = { createDocumentDecisionAuthority };
