/** Operator-authenticated relay; Praxis owns the durable request and execution. */
const express = require('express');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { praxisFetch, operatorProvenanceHeaders } = require('../services/praxis-client');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);

module.exports = function createAutomaticStartRouter({ authorize = createDocumentDecisionAuthority(), relay = praxisFetch, sign = operatorProvenanceHeaders } = {}) {
    const router = express.Router();
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
    async function forward(res, path, options) {
        try {
            const response = await relay(path, { ...options, timeoutMs: 15000 });
            const body = await response.json();
            return res.status(response.status).json(body);
        } catch {
            return res.status(502).json({ error: 'Praxis could not confirm the automatic-start request. Refresh its status before trying again.' });
        }
    }
    router.get('/', (_req, res) => forward(res, '/api/dispatch/automatic-start', { method: 'GET' }));
    async function mutate(req, res, action) {
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Use the automatic-start control from your Nexus session.' });
        const auth = await authorize(req);
        if (!auth?.ok || !OPERATORS.has(auth.actor?.authority)) return res.status(auth?.ok ? 403 : auth?.status || 403).json({
            error: 'Sign in to Nexus as Robert to change automatic starts.', code: 'operator_required', actionUrl: 'https://nexus.vibeshiftai.com/calendar',
        });
        const body = req.body || {};
        const taskId = action === 'create' ? body.taskId : req.params.taskId;
        const allowed = action === 'create' ? ['taskId', 'expectedVersion'] : ['expectedRequestedAt'];
        if (!validId(taskId) || Object.keys(body).some(k => !allowed.includes(k)) ||
            (action === 'create' && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0)) ||
            (action === 'cancel' && (typeof body.expectedRequestedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedRequestedAt))))) {
            return res.status(400).json({ error: 'Refresh the task and submit its current automatic-start action.' });
        }
        const payload = action === 'create' ? { taskId, expectedVersion: body.expectedVersion } : { expectedRequestedAt: body.expectedRequestedAt };
        const message = action === 'create' ? { action, taskId, expectedVersion: body.expectedVersion } : { action, taskId, expectedRequestedAt: body.expectedRequestedAt };
        const headers = sign(JSON.stringify(message), { surface: 'automatic-start' });
        if (!Object.keys(headers).length) return res.status(503).json({ error: 'The Nexus-to-Praxis operator relay is unavailable. No automatic start was requested.' });
        return forward(res, '/api/dispatch/automatic-start' + (action === 'cancel' ? '/' + encodeURIComponent(taskId) : ''), {
            method: action === 'create' ? 'POST' : 'DELETE', body: payload, headers,
        });
    }
    router.post('/', (req, res, next) => mutate(req, res, 'create').catch(next));
    router.delete('/:taskId', (req, res, next) => mutate(req, res, 'cancel').catch(next));
    return router;
};
