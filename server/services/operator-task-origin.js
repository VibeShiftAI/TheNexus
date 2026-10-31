/**
 * Who filed a task, as far as Nexus can verify it (2026-10-29).
 *
 * Robert files work two ways, and before this module neither was labelled as
 * his: a board create was recorded as `nexus-api` (the label every
 * unverified operator claim is capped to, which Praxis's planner reads as
 * machine work and holds back under `upgrade_posture=propose`), and a chat
 * dispatch carried no source at all (so executors received his own brief
 * wrapped as untrusted reference data). The labels below are recorded by the
 * server only after it has verified who asked; a request body can never
 * claim them (server/lib/provenance.js, normalizeSourceClaim).
 *
 *   operator:board  POST /api/projects/:id/tasks with `operator: true`. The
 *                   flag is a request, not proof. The proof is one of the
 *                   operator sessions Nexus already trusts for document
 *                   decisions and operator dispatch
 *                   (document-decision-authority.js): a Cloudflare Access
 *                   operator session, a pinned travel-shell device, the
 *                   verified local Mac session, or the operator credential.
 *                   Without one the task is still created (an idea is never
 *                   lost to a missing session) and recorded as `nexus-api`.
 *
 *   operator:chat   POST /api/tasks/batch from Praxis's chat dispatch. Praxis
 *                   signs an attestation for the created task ONLY when the
 *                   chat turn that asked for it carried verified operator
 *                   provenance (Praxis src/operator-provenance.ts, which
 *                   verifies the header this server's chat relay signs).
 *
 * Attestation wire format (pinned against a raw-crypto reference in both
 * repos: server/__tests__/operator-task-origin.test.js here, Praxis
 * tests/operator_provenance.test.ts there; change both or neither):
 *
 *   X-Praxis-Operator-Task: v1;surface=chat-dispatch;ts=<unix ms>;nonce=<hex>;sig=<hex>
 *   sig = HMAC-SHA256(PRAXIS_OPERATOR_KEY,
 *         "praxis-operator-task/v1\n<surface>\n<ts>\n<nonce>\n<sha256 hex of "<project_id>\n<task name>">")
 *
 * The key is the one the chat relay already shares with Praxis
 * (/Volumes/Projects/.fleet-env, see praxis-client.js). The distinct
 * `praxis-operator-task/v1` prefix keeps an attestation from ever verifying
 * as chat provenance, or the reverse. The signature binds the project and
 * the task name, `ts` bounds its life to five minutes, and each nonce is
 * accepted once. Dispatched executors cannot mint one: Praxis removes the
 * key from its own environment at boot, so no child process inherits it.
 * Neither the key nor a signature is ever logged.
 */
const crypto = require('node:crypto');
const { OPERATOR_ORIGIN_SOURCES } = require('../lib/provenance');
const { createDocumentDecisionAuthority } = require('./document-decision-authority');

const OPERATOR_TASK_HEADER = 'x-praxis-operator-task';
const SIGNING_PREFIX = 'praxis-operator-task/v1';
const MAX_AGE_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;
const KEY_MIN_CHARS = 32;
// Attested surface → the origin label it earns.
const SURFACE_SOURCES = Object.freeze({ 'chat-dispatch': OPERATOR_ORIGIN_SOURCES.chat });
// The same human authorities task-dispatch-proof.js accepts for operator dispatch.
const BOARD_AUTHORITIES = new Set(['access_user', 'access_device', 'operator_credential']);

function operatorKey() {
    const raw = process.env.PRAXIS_OPERATOR_KEY;
    const key = typeof raw === 'string' ? raw.trim() : '';
    return key.length >= KEY_MIN_CHARS ? key : null;
}

function taskDigest(projectId, name) {
    return crypto.createHash('sha256').update(`${projectId}\n${name}`, 'utf8').digest('hex');
}

function parse(presented) {
    const parts = presented.trim().split(';');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const fields = {};
    for (const part of parts.slice(1)) {
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const { surface, ts, nonce, sig } = fields;
    if (!surface || !ts || !nonce || !sig) return null;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(surface)) return null;
    if (!/^[0-9]{1,16}$/.test(ts)) return null;
    if (nonce.length < 16 || nonce.length > 64 || !/^[0-9a-f]+$/.test(nonce)) return null;
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    return { surface, ts, nonce, sig };
}

/**
 * One verifier per router: its nonce memory is what makes each attestation
 * single-use. Never throws; refusals carry a fixed reason for the log line.
 */
function createOperatorTaskAttestationVerifier({ now = Date.now } = {}) {
    const seen = new Map(); // nonce -> instant it stops mattering
    return function verifyOperatorTaskAttestation(presented, { projectId, name } = {}) {
        const key = operatorKey();
        if (!key) return { ok: false, reason: 'not-configured' };
        if (presented === undefined || presented === null || presented === '') return { ok: false, reason: 'missing' };
        if (typeof presented !== 'string' || presented.length > 512) return { ok: false, reason: 'malformed' };
        if (typeof projectId !== 'string' || !projectId || typeof name !== 'string' || !name) {
            return { ok: false, reason: 'malformed' };
        }
        const parsed = parse(presented);
        if (!parsed) return { ok: false, reason: 'malformed' };
        if (!Object.hasOwn(SURFACE_SOURCES, parsed.surface)) return { ok: false, reason: 'unknown-surface' };

        const expected = crypto.createHmac('sha256', key)
            .update(`${SIGNING_PREFIX}\n${parsed.surface}\n${parsed.ts}\n${parsed.nonce}\n${taskDigest(projectId, name)}`, 'utf8')
            .digest();
        const given = Buffer.from(parsed.sig, 'hex');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            return { ok: false, reason: 'bad-signature' };
        }
        const current = now();
        const signedAt = Number(parsed.ts);
        if (signedAt + MAX_AGE_MS < current) return { ok: false, reason: 'stale' };
        if (signedAt > current + FUTURE_SKEW_MS) return { ok: false, reason: 'future-dated' };
        for (const [nonce, until] of seen) if (until < current) seen.delete(nonce);
        if (seen.has(parsed.nonce)) return { ok: false, reason: 'replayed' };
        seen.set(parsed.nonce, signedAt + MAX_AGE_MS + FUTURE_SKEW_MS);
        return { ok: true, surface: parsed.surface, source: SURFACE_SOURCES[parsed.surface] };
    };
}

/**
 * Board creates: `operator: true` asks for the operator origin; only a
 * verified operator session grants it. Returns { requested, verified, reason? }.
 */
function createBoardOriginCheck({ authorize } = {}) {
    // Created on first use so booting the router adds no second set of
    // operator-access configuration warnings (ai-chat already reports them).
    let authority = authorize || null;
    return async function boardOrigin(req) {
        if (req.body?.operator !== true) return { requested: false, verified: false };
        if (req.get('sec-fetch-site') === 'cross-site') return { requested: true, verified: false, reason: 'cross-site' };
        try {
            if (!authority) authority = createDocumentDecisionAuthority();
            const auth = await authority(req);
            if (auth?.ok && BOARD_AUTHORITIES.has(auth.actor?.authority)) return { requested: true, verified: true };
            return { requested: true, verified: false, reason: auth?.code || 'operator_required' };
        } catch {
            return { requested: true, verified: false, reason: 'check-unavailable' };
        }
    };
}

function createOperatorTaskOrigin({ authorize, now } = {}) {
    return {
        boardOrigin: createBoardOriginCheck({ authorize }),
        verifyChatAttestation: createOperatorTaskAttestationVerifier({ now }),
    };
}

module.exports = {
    OPERATOR_TASK_HEADER,
    createOperatorTaskOrigin,
    createBoardOriginCheck,
    createOperatorTaskAttestationVerifier,
};
