/**
 * Client project access routes (2026-10-02). Shapes: @praxis/contract
 * entities/client-access.ts; ledger and invariants: db/client-access.js;
 * consumer contract: docs/contracts/client-project-access.md.
 *
 * Two surfaces, two mounts.
 *
 * Client surface, mounted at /api/client-access. Only the trusted runtime may
 * call it (NEXUS_STAKEHOLDER_RUNTIME_KEY bearer, the credential Praxis already
 * holds for stakeholder receipts). The runtime resolves the member from that
 * member's own authenticated portal session before calling; Nexus never
 * derives a client identity from a query parameter, a claimed name or an
 * email, and the member id in the path is honored only under that credential.
 * Every read re-checks the entitlement. Every review requires a session
 * assertion (x-client-session-sha256 + x-client-session-expires) that the
 * ledger records with the decision.
 *   GET  /members/:memberId/projects
 *   GET  /members/:memberId/projects/:projectId
 *   GET  /members/:memberId/projects/:projectId/artifacts/:artifactId
 *   POST /members/:memberId/projects/:projectId/artifacts/:artifactId/reviews
 *
 * Operator surface, mounted at /api/projects (project-scoped cockpit seam):
 *   GET  /:id/client-access                                  summary (cockpit read)
 *   POST /:id/client-access/entitlements                     grant (Robert's operator credential)
 *   POST /:id/client-access/entitlements/:entitlementId/revoke  revoke (operator credential)
 *   POST /:id/client-access/artifacts                        publish a version (runtime or operator credential)
 *   POST /:id/client-access/artifacts/:artifactId/withdraw   withdraw (runtime or operator credential)
 *
 * Denials on the client surface are one uniform 403 (`not_entitled`) so a
 * caller cannot learn whether another member or project exists. The local
 * `req.user` stub, member/PDM status, the bridge token and the operator
 * credential confer nothing on the client surface; the runtime credential
 * confers nothing on grant or revoke.
 */
const express = require('express');
const { requireStakeholderAuthority } = require('../services/stakeholder-authority');

const SESSION_SHA256_HEADER = 'x-client-session-sha256';
const SESSION_EXPIRES_HEADER = 'x-client-session-expires';
const ERROR_STATUSES = [400, 401, 403, 404, 409, 503];

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

function respondError(res, error) {
    const status = ERROR_STATUSES.includes(error.status) ? error.status : 500;
    if (status === 500) console.error('[ClientAccess] operation failed:', error);
    res.status(status).json({ error: status === 500 ? 'Client access operation failed' : error.message, ...(error.code ? { code: error.code } : {}) });
}

/** The runtime's assertion of the authenticated portal session it is acting for. */
function sessionAssertion(req, { required }) {
    const sha256 = req.get(SESSION_SHA256_HEADER);
    const expires = req.get(SESSION_EXPIRES_HEADER);
    if (!sha256 && !expires) {
        if (required) throw fail(401, 'Authenticated client session assertion required', 'session_required');
        return null;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw fail(401, 'Client session assertion is malformed', 'session_invalid');
    const at = Date.parse(expires || '');
    if (!Number.isFinite(at)) throw fail(401, 'Client session assertion is malformed', 'session_invalid');
    if (at <= Date.now()) throw fail(401, 'Client session has expired', 'session_expired');
    return { sha256, expires_at: new Date(at).toISOString() };
}

/** Publishing a version for review is routine runtime work; Robert may also do it. */
function requirePublisherAuthority(req) {
    const errors = [];
    for (const role of ['runtime', 'operator']) {
        try { return requireStakeholderAuthority(req, role); } catch (error) { errors.push(error); }
    }
    throw errors.find(error => error.status === 403) || errors[0];
}

function createClientAccessRouters({ db }) {
    const store = () => {
        if (!db || !db.clientAccess) throw fail(503, 'Client access database unavailable');
        return db.clientAccess;
    };
    const actorFor = authority => (authority === 'operator_credential' ? 'robert' : 'runtime');

    // ── Client surface ────────────────────────────────────────────────────
    const client = express.Router();
    client.use((req, res, next) => {
        try {
            req.clientAccessAuthority = requireStakeholderAuthority(req, 'runtime');
            next();
        } catch (error) { respondError(res, error); }
    });
    client.get('/members/:memberId/projects', (req, res) => {
        try {
            const session = sessionAssertion(req, { required: false });
            res.json({ member_id: req.params.memberId, projects: store().listMemberProjects(req.params.memberId), session: session ? { expires_at: session.expires_at } : null });
        } catch (error) { respondError(res, error); }
    });
    client.get('/members/:memberId/projects/:projectId', (req, res) => {
        try {
            const session = sessionAssertion(req, { required: false });
            const workspace = store().workspace(req.params.memberId, req.params.projectId);
            res.json({ ...workspace, session: session ? { expires_at: session.expires_at } : null });
        } catch (error) { respondError(res, error); }
    });
    client.get('/members/:memberId/projects/:projectId/artifacts/:artifactId', (req, res) => {
        try {
            sessionAssertion(req, { required: false });
            res.json(store().artifactForMember(req.params.memberId, req.params.projectId, req.params.artifactId));
        } catch (error) { respondError(res, error); }
    });
    client.post('/members/:memberId/projects/:projectId/artifacts/:artifactId/reviews', (req, res) => {
        try {
            const session = sessionAssertion(req, { required: true });
            const result = store().recordReview(req.params.memberId, req.params.projectId, req.params.artifactId, req.body || {}, { session, authority: req.clientAccessAuthority });
            res.status(result.duplicate ? 200 : 201).json(result);
        } catch (error) { respondError(res, error); }
    });

    // ── Operator surface (project-scoped) ─────────────────────────────────
    const projects = express.Router();
    projects.get('/:id/client-access', (req, res) => {
        try { res.json(store().listForProject(req.params.id)); } catch (error) { respondError(res, error); }
    });
    projects.post('/:id/client-access/entitlements', (req, res) => {
        try {
            const authority = requireStakeholderAuthority(req, 'operator');
            const result = store().grant(req.params.id, req.body || {}, { by: 'robert', authority });
            res.status(result.duplicate ? 200 : 201).json(result);
        } catch (error) { respondError(res, error); }
    });
    projects.post('/:id/client-access/entitlements/:entitlementId/revoke', (req, res) => {
        try {
            const authority = requireStakeholderAuthority(req, 'operator');
            res.json(store().revoke(req.params.id, req.params.entitlementId, req.body || {}, { by: 'robert', authority }));
        } catch (error) { respondError(res, error); }
    });
    projects.post('/:id/client-access/artifacts', (req, res) => {
        try {
            const authority = requirePublisherAuthority(req);
            const result = store().publishArtifact(req.params.id, req.body || {}, { by: actorFor(authority), authority });
            res.status(result.duplicate ? 200 : 201).json(result);
        } catch (error) { respondError(res, error); }
    });
    projects.post('/:id/client-access/artifacts/:artifactId/withdraw', (req, res) => {
        try {
            const authority = requirePublisherAuthority(req);
            res.json(store().withdrawArtifact(req.params.id, req.params.artifactId, req.body || {}, { by: actorFor(authority), authority }));
        } catch (error) { respondError(res, error); }
    });

    return { client, projects };
}

module.exports = createClientAccessRouters;
module.exports.SESSION_SHA256_HEADER = SESSION_SHA256_HEADER;
module.exports.SESSION_EXPIRES_HEADER = SESSION_EXPIRES_HEADER;
