/** Only Robert's authenticated session can grant or revoke project autonomy. */
const express = require('express');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { praxisFetch, operatorProvenanceHeaders } = require('../services/praxis-client');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
const validId = id => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id);
module.exports = function createMaintenanceRouter({ authorize = createDocumentDecisionAuthority(), relay = praxisFetch, sign = operatorProvenanceHeaders } = {}) {
    const router = express.Router();
    async function forward(res, id, options) {
        res.set('Cache-Control', 'no-store');
        try {
            const response = await relay(`/api/project-maintenance/${encodeURIComponent(id)}`, { ...options, timeoutMs: 30000 });
            return res.status(response.status).json(await response.json());
        } catch {
            return res.status(502).json({ error: 'Praxis could not confirm the settings. Reload before saving again.' });
        }
    }
    router.get('/:id', (req, res) => {
        if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid project identity' });
        return forward(res, req.params.id, { method: 'GET' });
    });
    router.put('/:id', async (req, res, next) => {
        try {
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Use maintenance settings from your Nexus session.' });
            const auth = await authorize(req);
            if (!auth?.ok || !OPERATORS.has(auth.actor?.authority)) return res.status(auth?.ok ? 403 : auth?.status || 403).json({ error: 'Sign in as Robert to change maintenance authority.', code: 'operator_required' });
            const { id } = req.params, body = req.body;
            if (!validId(id) || !body?.policy || typeof body.policy !== 'object' || Array.isArray(body.policy)) return res.status(400).json({ error: 'Invalid maintenance settings' });
            const headers = sign(JSON.stringify({ purpose: 'project-maintenance-policy', id, body }), { surface: 'maintenance-settings' });
            if (!Object.keys(headers).length) return res.status(503).json({ error: 'The operator relay is unavailable. No authority was changed.' });
            return forward(res, id, { method: 'PUT', body, headers });
        } catch (error) { next(error); }
    });
    return router;
};
