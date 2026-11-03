const express = require('express');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { praxisProxyJson, operatorProvenanceHeaders } = require('../services/praxis-client');

const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);

function createSkillCandidatesRouter({ authorize = createDocumentDecisionAuthority(), sign = operatorProvenanceHeaders } = {}) {
    const router = express.Router();

    router.get('/:id/review', (req, res) => {
        res.set('Cache-Control', 'no-store');
        return praxisProxyJson(res, `/skill-candidates/${encodeURIComponent(req.params.id)}/review`);
    });

    router.post('/:id/decide', async (req, res) => {
        const { id } = req.params;
        const decision = req.body?.decision;
        if (decision !== 'apply-amendment') {
            return praxisProxyJson(res, '/skill-candidates/decide', { method: 'POST', body: { id, decision } });
        }
        if (req.get('sec-fetch-site') === 'cross-site') {
            return res.status(403).json({ error: 'Apply the amendment from your Nexus session.' });
        }
        const auth = await authorize(req);
        if (!auth?.ok || !OPERATORS.has(auth.actor?.authority)) {
            return res.status(auth?.ok ? 403 : auth?.status || 403).json({ error: 'An operator session is required to apply a skill amendment.' });
        }
        const reviewId = req.body?.reviewId;
        if (typeof reviewId !== 'string' || !reviewId.trim()) {
            return res.status(400).json({ error: 'Open the current amendment diff before applying it.' });
        }
        const message = JSON.stringify({ purpose: 'skill-amendment-apply', id, reviewId });
        const headers = sign(message, { surface: 'nexus-skill-amendment' });
        if (!Object.keys(headers).length) {
            return res.status(503).json({ error: 'The Nexus-to-Praxis operator relay is unavailable.' });
        }
        return praxisProxyJson(res, '/skill-candidates/decide', { method: 'POST', headers, body: { id, decision, reviewId } });
    });

    return router;
}

module.exports = createSkillCandidatesRouter;
