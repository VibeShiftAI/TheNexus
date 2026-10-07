/** Exact-envelope review surface only. Praxis owns the delivery operation. */
const express = require('express');
const { requireStakeholderAuthority } = require('../services/stakeholder-authority');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
const FINAL = new Set(['delivering', 'sent', 'uncertain']);
const CONTROL = /[\u0000-\u001f\u007f]/;
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const invalid = message => fail(400, 'invalid_outgoing', message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(body, allowed) {
    if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) invalid('Unknown or invalid outgoing request fields');
}
function string(value, name, max = 300) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) invalid(`${name} must be a nonempty printable string`);
    return value;
}
function snapshot(body, extra = []) {
    fields(body, ['revision_id', 'envelope_hash', ...extra]);
    string(body.revision_id, 'revision_id');
    if (typeof body.envelope_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.envelope_hash)) invalid('envelope_hash must identify an exact outgoing version');
}
function prepareInput(body) {
    fields(body, ['revision_id', 'envelope', 'provenance', 'expected_envelope_hash']);
    string(body.revision_id, 'revision_id');
    if (body.expected_envelope_hash !== undefined && (typeof body.expected_envelope_hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.expected_envelope_hash))) invalid('Invalid expected_envelope_hash');
    const e = body.envelope;
    fields(e, ['to', 'cc', 'subject', 'text', 'attachments']);
    function email(value) {
        string(value, 'recipient', 320);
        if (!/^[^\s@<>(),;:"\\\[\]]+@[^\s@<>(),;:"\\\[\]]+\.[^\s@<>(),;:"\\\[\]]+$/.test(value)) invalid('Recipients must be explicit email addresses');
        return value;
    }
    const to = email(e.to);
    if (!Array.isArray(e.cc) || e.cc.length > 50) invalid('cc must be an array of email addresses');
    const cc = e.cc.map(email);
    const subject = string(e.subject, 'subject', 998);
    if (typeof e.text !== 'string' || !e.text.trim() || e.text.length > 100000 || e.text.includes('\u0000')) invalid('text must be the nonempty exact message body');
    if (!Array.isArray(e.attachments) || e.attachments.length) invalid('Only an empty attachments array is supported');
    const p = body.provenance;
    fields(p, ['member_id', 'project_id', 'task_id', 'source_refs', 'commitment_id']);
    const provenance = { member_id: string(p.member_id, 'member_id'), project_id: string(p.project_id, 'project_id'), task_id: string(p.task_id, 'task_id') };
    if (!Array.isArray(p.source_refs) || !p.source_refs.length || p.source_refs.length > 100) invalid('source_refs must name the message sources');
    provenance.source_refs = p.source_refs.map(value => string(value, 'source_ref', 2000));
    if (p.commitment_id !== undefined) provenance.commitment_id = string(p.commitment_id, 'commitment_id');
    return { revision_id: body.revision_id, envelope: { to, cc, subject, text: e.text, attachments: [] }, provenance,
        ...(body.expected_envelope_hash !== undefined ? { expected_envelope_hash: body.expected_envelope_hash } : {}) };
}

function createDocumentOutgoingRouter({ store, captureRevision, authorizeDecision }) {
    const router = express.Router({ mergeParams: true });
    function route(fn) {
        return async (req, res) => {
            try {
                const doc = store().getDocument(req.params.id);
                if (!doc) return res.status(404).json({ error: 'Document not found' });
                await fn(req, res, doc);
            } catch (err) {
                if (!err.status) console.error('[DocumentOutgoing]', err);
                res.status(err.status || 500).json({ code: err.code || 'outgoing_failed', error: err.status ? err.message : 'Outgoing request failed' });
            }
        };
    }
    async function capture(doc, revisionId) {
        const captured = await captureRevision(doc);
        if (captured.fileState !== 'ok') fail(409, 'file_unavailable', 'The file cannot be confirmed; its send grant has been revoked');
        if (!captured.revision || captured.revision.id !== revisionId) fail(409, 'stale_revision', 'The document changed; reload and review its current revision');
        return captured.revision;
    }
    router.get('/', route(async (_req, res, doc) => {
        await captureRevision(doc);
        res.json({ outgoing: store().getOutgoing(doc.id) });
    }));
    router.get('/history', route(async (_req, res, doc) => {
        res.json({ history: store().listOutgoingEvents(doc.id) });
    }));
    router.put('/', route(async (req, res, doc) => {
        requireStakeholderAuthority(req, 'runtime');
        const input = prepareInput(req.body);
        const revision = await capture(doc, input.revision_id);
        res.json({ outgoing: store().prepareOutgoing(doc.id, revision, input) });
    }));
    router.post('/decision', route(async (req, res, doc) => {
        if (req.get('sec-fetch-site') === 'cross-site') fail(403, 'cross_site', 'Same-origin requests only');
        const auth = await authorizeDecision(req);
        if (!auth?.ok) return res.status(auth?.status || 403).json({ error: auth?.error || 'Operator required', code: auth?.code || 'operator_required' });
        if (!OPERATORS.has(auth.actor?.authority)) fail(403, 'operator_required', 'Only a direct operator decision can authorize or cancel sending');
        const input = req.body;
        snapshot(input, ['decision']);
        if (!['approve_send', 'cancel'].includes(input.decision)) invalid('decision must be approve_send or cancel');
        // A missing or superseded file must not prevent the operator cancelling.
        if (input.decision === 'approve_send') await capture(doc, input.revision_id);
        res.json({ outgoing: store().decideOutgoing(doc.id, input, auth.actor) });
    }));
    router.post('/claim', route(async (req, res, doc) => {
        requireStakeholderAuthority(req, 'runtime');
        const input = req.body;
        snapshot(input, ['delivery_id']);
        string(input.delivery_id, 'delivery_id');
        // Lost-response retries can only observe the durable claim, never send again.
        if (!FINAL.has(store().getOutgoing(doc.id)?.status)) await capture(doc, input.revision_id);
        res.json(store().claimOutgoing(doc.id, input));
    }));
    router.post('/receipt', route(async (req, res, doc) => {
        requireStakeholderAuthority(req, 'runtime');
        const input = req.body;
        fields(input, ['delivery_id', 'status', 'message_id']);
        string(input.delivery_id, 'delivery_id');
        if (!['sent', 'uncertain'].includes(input.status)) invalid('receipt status must be sent or uncertain');
        if (input.message_id !== undefined) string(input.message_id, 'message_id', 2000);
        res.json({ outgoing: store().receiptOutgoing(doc.id, input) });
    }));
    return router;
}
module.exports = { createDocumentOutgoingRouter };
