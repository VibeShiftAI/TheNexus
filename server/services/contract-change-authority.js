/**
 * Who is changing a task's contract, as far as Nexus can verify it.
 *
 * Robert's rule (task 9021f20d, 2026-10-04): when he changes a task's contract,
 * directly or through a faithful Praxis relay of a decision he already made,
 * the change is authorized and he is never asked to approve it again. Only a
 * contract change an executor or QA makes during execution is held. For that
 * rule to be safe the origin has to be a checked credential, never a label in
 * the payload: "source: robert" or "operator: true" proves nothing.
 *
 * Origins this module can establish:
 *
 *   operator           Robert's verified Cloudflare Access session (the tunnel
 *                      browser, phone shell, travel shell) or his operator
 *                      bearer credential (NEXUS_OPERATOR_APPROVAL_KEY) on a
 *                      trusted operator tool. Executors never inherit that key.
 *   operator_relayed   the Praxis runtime credential plus a `decision_ref`
 *                      naming the decision of Robert's it is applying. Nexus
 *                      checks references it holds (a recorded operator ruling,
 *                      a document decision); a chat instruction stays labelled
 *                      as a runtime attestation.
 *   runtime            the runtime credential with no relayed decision.
 *   unverified         everything else: the dashboard's placeholder bearer,
 *                      executor curls, praxis-mind MCP writes, the QA reviewer.
 *
 * A PATCH without a `contract_change` block is classified silently and never
 * fails on credentials; its edits are recorded, and held only during
 * execution. A PATCH that claims an origin in `contract_change` must prove it
 * or nothing is written.
 */
const { createOperatorAuthenticator } = require('./operator-access');
const { requireStakeholderAuthority } = require('./stakeholder-authority');

const ORIGIN_CLAIMS = new Set(['operator', 'operator_relayed']);
const REF_KINDS = new Set(['operator_ruling', 'document_decision', 'chat_instruction', 'inbox_answer', 'questionnaire']);

const refuse = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const executorHeaders = req => Boolean(req.get('x-praxis-bridge-token') || req.get('cf-access-client-id') || req.get('cf-access-client-secret'));

function credential(req, role) {
    try { return { ok: true, authority: requireStakeholderAuthority(req, role) }; }
    catch (error) { return { ok: false, status: error.status, message: error.message }; }
}

/** Shape check only; the task-bound checks (ruling hash, decision row) happen in the admission guard. */
function parseContractChange(block) {
    if (block === undefined || block === null) return null;
    if (typeof block !== 'object' || Array.isArray(block)) throw refuse(400, 'contract_change_invalid', 'contract_change must be an object');
    if (!ORIGIN_CLAIMS.has(block.origin)) throw refuse(400, 'contract_change_invalid', 'contract_change.origin must be operator or operator_relayed');
    const parsed = { origin: block.origin };
    if (block.fields !== undefined) {
        if (!Array.isArray(block.fields) || block.fields.some(field => typeof field !== 'string' || !field.trim())) throw refuse(400, 'contract_change_invalid', 'contract_change.fields must list field names');
        parsed.fields = block.fields.map(field => field.trim());
    }
    if (block.reason !== undefined) {
        if (typeof block.reason !== 'string' || block.reason.length > 2000) throw refuse(400, 'contract_change_invalid', 'contract_change.reason must be a string of at most 2000 characters');
        parsed.reason = block.reason;
    }
    if (block.decision_ref !== undefined) {
        const ref = block.decision_ref;
        if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !REF_KINDS.has(ref.kind)) throw refuse(400, 'contract_change_invalid', `contract_change.decision_ref.kind must be one of ${[...REF_KINDS].join(', ')}`);
        parsed.decision_ref = ref;
    }
    if (parsed.origin === 'operator_relayed') {
        if (!parsed.decision_ref) throw refuse(400, 'contract_change_invalid', 'A relayed operator decision must name the decision it relays (contract_change.decision_ref)');
        if (!parsed.fields || !parsed.fields.length) throw refuse(400, 'contract_change_invalid', 'A relayed operator decision must declare the contract fields it changes (contract_change.fields)');
    }
    return parsed;
}

function createContractChangeAuthority({ authenticateOperator } = {}) {
    let operator = authenticateOperator || null;

    async function operatorSession(req) {
        // Only a request that carries an Access assertion can hold a session;
        // skipping the check otherwise keeps unauthenticated PATCHes cheap and
        // avoids the authenticator's configuration warnings on every write.
        if (!req.get('cf-access-jwt-assertion')) return { operator: false, reason: 'assertion-missing' };
        if (!operator) operator = createOperatorAuthenticator();
        try { return await operator.inspect(req); }
        catch { return { operator: false, reason: 'check-unavailable' }; }
    }

    /** Classify a task write. Throws (status, code) only when `contract_change` claims more than the request proves. */
    async function classifyWrite(req, body = req.body) {
        const claim = parseContractChange(body?.contract_change);
        const bridge = executorHeaders(req);
        if (claim && bridge) throw refuse(403, 'contract_change_unverified', 'Executor and bridge credentials cannot assert an operator origin');
        if (claim?.origin === 'operator_relayed') {
            const runtime = credential(req, 'runtime');
            if (!runtime.ok) throw refuse(runtime.status === 503 ? 503 : 403, runtime.status === 503 ? 'contract_change_unverifiable' : 'contract_change_unverified',
                runtime.status === 503 ? 'The runtime credential is not configured; a relayed decision cannot be verified' : 'A relayed operator decision needs the Praxis runtime credential');
            return { kind: 'operator_relayed', authority: 'runtime_credential', requester: 'runtime', decision_ref: claim.decision_ref, fields: claim.fields, ...(claim.reason ? { reason: claim.reason } : {}) };
        }
        const session = bridge ? { operator: false, reason: 'executor-headers' } : await operatorSession(req);
        if (session.operator) {
            return { kind: 'operator', authority: session.identity === 'device' ? 'access_device' : 'access_user', requester: 'operator',
                ...(claim?.reason ? { reason: claim.reason } : {}), ...(claim?.decision_ref ? { decision_ref: claim.decision_ref } : {}), ...(claim?.fields ? { fields: claim.fields } : {}) };
        }
        const bearer = req.get('authorization') && !bridge ? credential(req, 'operator') : { ok: false };
        if (bearer.ok) {
            return { kind: 'operator', authority: 'operator_credential', requester: 'operator',
                ...(claim?.reason ? { reason: claim.reason } : {}), ...(claim?.decision_ref ? { decision_ref: claim.decision_ref } : {}), ...(claim?.fields ? { fields: claim.fields } : {}) };
        }
        if (claim) {
            if (session.reason === 'check-unavailable') throw refuse(503, 'contract_change_unverifiable', 'Operator identity could not be checked; the change was not written');
            if (bearer.status === 503) throw refuse(503, 'contract_change_unverifiable', 'The operator credential is not configured; an operator origin cannot be verified', { reason: session.reason });
            throw refuse(403, 'contract_change_unverified', 'This request claims an operator origin but carries neither Robert’s verified session nor his operator credential', { reason: session.reason });
        }
        const runtime = req.get('authorization') && !bridge ? credential(req, 'runtime') : { ok: false };
        if (runtime.ok) return { kind: 'runtime', authority: 'runtime_credential', requester: 'runtime' };
        return { kind: 'unverified', authority: null, requester: bridge ? 'executor_bridge' : req.get('authorization') ? 'unverified_bearer' : 'unauthenticated',
            session_reason: session.reason };
    }

    /** Who may decide a contract hold: the same proofs, with the runtime allowed only to relay a named decision. */
    async function classifyDecision(req, body = req.body) {
        const bridge = executorHeaders(req);
        if (bridge) throw refuse(403, 'contract_decision_unauthorized', 'Executor and bridge credentials cannot decide a contract hold');
        const session = await operatorSession(req);
        const base = { ...(typeof body?.reason === 'string' ? { reason: body.reason.slice(0, 2000) } : {}) };
        if (session.operator) return { kind: 'operator', authority: session.identity === 'device' ? 'access_device' : 'access_user', requester: 'operator', ...base, ...(body?.decision_ref ? { decision_ref: body.decision_ref } : {}) };
        if (req.get('authorization')) {
            const bearer = credential(req, 'operator');
            if (bearer.ok) return { kind: 'operator', authority: 'operator_credential', requester: 'operator', ...base, ...(body?.decision_ref ? { decision_ref: body.decision_ref } : {}) };
            const runtime = credential(req, 'runtime');
            if (runtime.ok) {
                const ref = body?.decision_ref;
                if (!ref || typeof ref !== 'object' || !REF_KINDS.has(ref.kind)) throw refuse(400, 'contract_change_invalid', 'The runtime may relay a contract decision only with the decision_ref it applies');
                return { kind: 'operator_relayed', authority: 'runtime_credential', requester: 'runtime', decision_ref: ref, ...base };
            }
            if (bearer.status === 503 && runtime.status === 503) throw refuse(503, 'contract_decision_unavailable', 'Neither operator nor runtime credential is configured', { reason: session.reason });
        }
        if (session.reason === 'check-unavailable') throw refuse(503, 'contract_decision_unavailable', 'Operator identity could not be checked; no decision was recorded');
        throw refuse(403, 'contract_decision_unauthorized',
            'Deciding a contract hold needs Robert’s verified operator session, his operator credential, or a Praxis relay of his recorded decision; this request carries none',
            { reason: session.reason });
    }

    return { classifyWrite, classifyDecision, parseContractChange };
}

module.exports = { createContractChangeAuthority, parseContractChange };
