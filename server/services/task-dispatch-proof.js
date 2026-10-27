/** A caller flag is not operator identity. Only verified human dispatches get a proof. */
const { createDocumentDecisionAuthority } = require('./document-decision-authority');
const { operatorProvenanceHeaders } = require('./praxis-client');
const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
module.exports = function taskDispatchProof({ authorize = createDocumentDecisionAuthority(), sign = operatorProvenanceHeaders } = {}) {
    return async (req, res, next) => {
        if (req.body?.operator !== true) return next();
        try {
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Use the Dispatch button from your Nexus session.' });
            const auth = await authorize(req);
            if (!auth?.ok || !OPERATORS.has(auth.actor?.authority)) return res.status(auth?.ok ? 403 : auth?.status || 403).json({ error: 'An authenticated Robert session is required for operator dispatch.', code: 'operator_required' });
            const proof = sign(JSON.stringify(req.body), { surface: 'task-dispatch' });
            if (!Object.keys(proof).length) return res.status(503).json({ error: 'The operator relay is unavailable. No operator dispatch was authorized.' });
            req.taskDispatchProof = proof;
            return next();
        } catch (error) { next(error); }
    };
};
