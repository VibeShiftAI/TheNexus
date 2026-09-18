const { timingSafeEqual } = require('crypto');
/** Separate credentials: the requester/runtime can never manufacture an operator decision.
 * Fail closed when unconfigured. Neither req.user (local stub) nor labels are credentials.
 */
function requireStakeholderAuthority(req, role) {
    const operator = process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    const runtime = process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    const key = role === 'operator' ? operator : runtime;
    if (!key || key.length < 32 || key === (role === 'operator' ? runtime : operator)) {
        throw Object.assign(new Error(`${role} stakeholder credential is not configured independently (minimum 32 characters)`), { status: 503 });
    }
    const supplied = Buffer.from(req.get('Authorization') || '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (req.get('x-praxis-bridge-token') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw Object.assign(new Error(`Trusted ${role === 'operator' ? 'Robert operator' : 'runtime'} credential required`), { status: 403 });
    }
    return `${role}_credential`;
}
module.exports = { requireStakeholderAuthority };
