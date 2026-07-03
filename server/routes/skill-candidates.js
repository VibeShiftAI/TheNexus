const express = require('express');

const { PRAXIS_URL } = require('../shared/constants');

async function proxyPraxisJson(res, upstreamPath, options = {}) {
    try {
        const response = await fetch(`${PRAXIS_URL}${upstreamPath}`, {
            method: options.method || 'GET',
            headers: {
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const text = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        res.send(text);
    } catch (err) {
        res.status(502).json({ error: err.message || 'Praxis unreachable' });
    }
}

/**
 * Individual approve/archive for nightly skill-harvest candidates.
 * Decoupled from the morning-plan approval (2026-07-03): the dashboard's
 * candidate buttons call this immediately; the plan's Approve button no
 * longer carries candidate decisions.
 */
function createSkillCandidatesRouter() {
    const router = express.Router();

    router.post('/:id/decide', (req, res) =>
        proxyPraxisJson(res, '/skill-candidates/decide', {
            method: 'POST',
            body: { id: req.params.id, decision: req.body?.decision },
        }));

    return router;
}

module.exports = createSkillCandidatesRouter;
