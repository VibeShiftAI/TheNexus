/** Mail decisions require direct operator identity, then a body-bound relay proof. */
const express = require('express');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { praxisFetch, operatorProvenanceHeaders } = require('../services/praxis-client');
const { operatorConfirmations, mailSendAction, sha256, NOT_ASKED } = require('../services/operator-confirmation');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
module.exports = function createMailDraftReviewRouter({ authorize = createDocumentDecisionAuthority(), relay = praxisFetch, sign = operatorProvenanceHeaders, confirmations = operatorConfirmations } = {}) {
    const router = express.Router();
    async function forward(res, path, options) {
        res.set('Cache-Control', 'no-store');
        try {
            const response = await relay(path, { ...options, timeoutMs: 30000 });
            return res.status(response.status).json(await response.json());
        } catch {
            return res.status(502).json({ error: 'Praxis could not confirm the mail action. Refresh to check its recorded status before trying again.' });
        }
    }
    // What Praxis would send for this draft right now, read from Praxis itself
    // (never from the client), so the confirmation names the real message.
    async function currentDraft(id) {
        const response = await relay('/api/mailbox/drafts-review?folder=drafts', { method: 'GET', timeoutMs: 30000 });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data?.items)) throw new Error('draft list unavailable');
        return data.items.find(item => item && item.id === id) || null;
    }
    router.get('/', (req, res) => {
        const folder = req.query.folder || 'drafts';
        if (!['drafts', 'cancelled'].includes(folder)) return res.status(400).json({ error: 'Invalid mail folder' });
        return forward(res, `/api/mailbox/drafts-review?folder=${folder}`, { method: 'GET' });
    });
    router.post('/:id', async (req, res, next) => {
        try {
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Use Praxis Mail from your Nexus session.' });
            const auth = await authorize(req);
            if (!auth?.ok || !OPERATORS.has(auth.actor?.authority)) return res.status(auth?.ok ? 403 : auth?.status || 403).json({ error: 'Sign in to Nexus as Robert to review email.', code: 'operator_required' });
            let body = req.body;
            if (!/^[A-Za-z0-9_-]{1,200}$/.test(req.params.id) || !body || typeof body !== 'object' || Array.isArray(body)
                || !['edit', 'approve_send', 'cancel', 'return_to_praxis', 'retry_feedback'].includes(body.action)) return res.status(400).json({ error: 'Invalid mail review action' });
            let confirmation = null;
            if (body.action === 'approve_send' && !NOT_ASKED.has(auth.via)) {
                // A send through the local session waits for Robert on this Mac.
                if (typeof body.version !== 'string' || !body.version) return res.status(400).json({ error: 'Invalid mail review action' });
                let draft;
                try {
                    draft = await currentDraft(req.params.id);
                } catch {
                    return res.status(502).json({ error: 'Praxis could not show this draft, so it cannot be confirmed. No mail decision was recorded.', nothing_recorded: true });
                }
                // Praxis would refuse these anyway; refuse before asking.
                if (!draft) return res.status(409).json({ error: 'This draft is no longer waiting for review; reload Praxis Mail. No mail decision was recorded.', nothing_recorded: true });
                if (draft.version !== body.version) return res.status(409).json({ error: 'Draft changed; reload the current version. No mail decision was recorded.', nothing_recorded: true });
                if (draft.status !== 'draft') return res.status(409).json({ error: `Draft is ${draft.status}; it cannot be sent. No mail decision was recorded.`, nothing_recorded: true });
                if (draft.blocked) return res.status(409).json({ error: `${draft.blocked} No mail decision was recorded.`, nothing_recorded: true });
                // Praxis gives every change, the HTML part included, a new version.
                const html = typeof draft.html === 'string' && draft.html.trim() ? draft.html : null;
                const identity = { kind: 'mail_send', source: 'praxis', draft_id: draft.id, version: draft.version, to: draft.to, cc: draft.cc, subject: draft.subject, body_sha256: sha256(draft.body), html_sha256: html === null ? null : sha256(html) };
                confirmation = await confirmations.confirm({ res, auth, action: mailSendAction({ identity, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, html }) });
                if (!confirmation.ok) {
                    return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code, nothing_recorded: true, ...(confirmation.confirmation_ref ? { confirmation_ref: confirmation.confirmation_ref } : {}) });
                }
                // Praxis refuses a version other than the one confirmed, so relay exactly that.
                if (!confirmation.consume(identity)) return res.status(409).json({ error: 'The confirmation could not be used. No mail decision was recorded.', code: 'operator_confirmation_mismatch', nothing_recorded: true });
                body = { action: 'approve_send', version: draft.version };
                console.log(`[MailDraftReview] relaying approve_send for ${draft.id} version ${draft.version} after operator confirmation ref=${confirmation.ref}`);
            }
            const headers = sign(JSON.stringify({ purpose: 'mail-draft-review', id: req.params.id, body }), { surface: 'mail-drafts' });
            if (!Object.keys(headers).length) return res.status(503).json({ error: 'The operator relay is unavailable. No mail decision was recorded.' });
            return forward(res, `/api/mailbox/drafts-review/${encodeURIComponent(req.params.id)}`, { method: 'POST', body, headers });
        } catch (error) { next(error); }
    });
    return router;
};
