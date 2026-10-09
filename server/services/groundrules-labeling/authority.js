/**
 * Who may write Robert's labels, judgments and annotations.
 *
 * The legacy `local_user` stub the server stamps on every request is not a
 * credential: dispatched executors and the QA reviewer reach this API as that
 * user too, and a fabricated label would poison the gold set. A write
 * therefore needs one of the two operator proofs Nexus already trusts for a
 * document decision (server/services/document-decision-authority.js), and
 * nothing else:
 *
 *   access_user / access_device  a verified Cloudflare Access operator session
 *                                (the tunnel browser, the phone shell, the
 *                                travel shell);
 *   operator_credential          Robert's operator bearer
 *                                (NEXUS_OPERATOR_APPROVAL_KEY), which the
 *                                labeling page lets him enter on a device
 *                                that carries no Access session (the Mac app
 *                                on localhost:3000).
 *
 * The document-scoped executor credential and the runtime credential are
 * refused by name: an executor records nothing here. Reads need no proof;
 * what a reader may see is gated by stage, not by identity.
 */
const { createOperatorAuthenticator } = require('../operator-access');
const { requireStakeholderAuthority } = require('../stakeholder-authority');

function deny(status, code, error, extra = {}) {
    return { ok: false, status, code, error, ...extra };
}

function createLabelingWriteAuthority({ authenticateOperator } = {}) {
    let operator = authenticateOperator || null;
    return async function authorizeLabelingWrite(req) {
        if (!req.user?.id) return deny(401, 'authentication_required', 'Authentication required');
        if (req.user.is_service) return deny(403, 'operator_required', 'Service accounts cannot record labels');
        if (req.get('x-praxis-bridge-token') || req.get('cf-access-client-id') || req.get('cf-access-client-secret')) {
            return deny(403, 'operator_required', 'Executor and bridge credentials cannot record labels');
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
            return { ok: true, actor: { id: req.user.id, authority: outcome.identity === 'device' ? 'access_device' : 'access_user' } };
        }
        const reason = checkFailed ? 'check-unavailable' : (outcome?.reason || 'unknown');
        if (req.get('authorization')) {
            try {
                requireStakeholderAuthority(req, 'operator');
                return { ok: true, actor: { id: req.user.id, authority: 'operator_credential' } };
            } catch (err) {
                if (err.status === 503) {
                    return deny(503, 'operator_credential_unconfigured', 'The operator credential is not configured on this host; nothing was saved', { reason });
                }
            }
            // Any other bearer (the dashboard placeholder, the runtime key, the
            // document executor key) is simply not an operator proof.
            return deny(403, 'operator_required', 'Saving needs Robert’s verified operator session or operator credential; the supplied credential is neither', { reason });
        }
        if (checkFailed) return deny(503, 'operator_check_unavailable', 'Operator identity could not be checked; nothing was saved');
        return deny(403, 'operator_required', 'Saving needs Robert’s verified operator session or operator credential; this request carries neither', { reason });
    };
}

module.exports = { createLabelingWriteAuthority };
