/** Mail decisions require direct operator identity, then a body-bound relay proof. */
const express = require('express');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { praxisFetch, operatorProvenanceHeaders } = require('../services/praxis-client');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
module.exports = function createMailDraftReviewRouter({ authorize = createDocumentDecisionAuthority(), relay = praxisFetch, sign = operatorProvenanceHeaders } = {}) {
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
            const body = req.body;
            if (!/^[A-Za-z0-9_-]{1,200}$/.test(req.params.id) || !body || typeof body !== 'object' || Array.isArray(body)
                || !['edit', 'approve_send', 'cancel', 'return_to_praxis', 'retry_feedback'].includes(body.action)) return res.status(400).json({ error: 'Invalid mail review action' });
            const headers = sign(JSON.stringify({ purpose: 'mail-draft-review', id: req.params.id, body }), { surface: 'mail-drafts' });
            if (!Object.keys(headers).length) return res.status(503).json({ error: 'The operator relay is unavailable. No mail decision was recorded.' });
            return forward(res, `/api/mailbox/drafts-review/${encodeURIComponent(req.params.id)}`, { method: 'POST', body, headers });
        } catch (error) { next(error); }
    });
    return router;
};
