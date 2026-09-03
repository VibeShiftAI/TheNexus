const express = require('express');

// Status/content-type/body forwarded verbatim, 502 on transport failure —
// the shared Praxis client owns the URL and the error shape (P1-14).
const { praxisProxyJson: proxyPraxisJson } = require('../services/praxis-client');

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
