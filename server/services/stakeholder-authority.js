const { timingSafeEqual } = require('crypto');
/**
 * Separate credentials: the requester/runtime can never manufacture an operator
 * decision. Fail closed when unconfigured. Neither req.user (local stub) nor
 * labels are credentials.
 *
 *   operator           NEXUS_OPERATOR_APPROVAL_KEY    Robert's own authority: reserved
 *                                                     stakeholder actions and direct
 *                                                     document decisions.
 *   runtime            NEXUS_STAKEHOLDER_RUNTIME_KEY  the Praxis runtime: receipts only,
 *                                                     never a decision.
 *   document_executor  NEXUS_DOCUMENT_APPROVAL_KEY    document-scoped delegated authority
 *                                                     (2026-10-04, task a2553798): a
 *                                                     dispatched executor records Robert's
 *                                                     own "approve with changes" review on
 *                                                     the resulting revision and nothing
 *                                                     else. Stakeholder endpoints ask for
 *                                                     `operator`, so this credential never
 *                                                     approves a scope change or an
 *                                                     invitation.
 *
 * Every key must be at least 32 characters and distinct from every other
 * configured key, so a misconfiguration that would merge two roles fails
 * closed for both of them.
 */
const ROLES = {
    operator: { env: 'NEXUS_OPERATOR_APPROVAL_KEY', label: 'Robert operator' },
    runtime: { env: 'NEXUS_STAKEHOLDER_RUNTIME_KEY', label: 'runtime' },
    document_executor: { env: 'NEXUS_DOCUMENT_APPROVAL_KEY', label: 'document executor' },
};

function requireStakeholderAuthority(req, role) {
    const spec = ROLES[role];
    if (!spec) throw Object.assign(new Error(`Unknown credential role: ${role}`), { status: 500 });
    const key = process.env[spec.env];
    const others = Object.entries(ROLES).filter(([name]) => name !== role).map(([, other]) => process.env[other.env]).filter(Boolean);
    if (!key || key.length < 32 || others.includes(key)) {
        throw Object.assign(new Error(`${role} stakeholder credential is not configured independently (minimum 32 characters)`), { status: 503 });
    }
    const supplied = Buffer.from(req.get('Authorization') || '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (req.get('x-praxis-bridge-token') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw Object.assign(new Error(`Trusted ${spec.label} credential required`), { status: 403 });
    }
    return `${role}_credential`;
}
module.exports = { requireStakeholderAuthority };
