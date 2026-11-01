const express = require('express');
const { requireLeases, sendLeaseError } = require('../lib/write-leases');

module.exports = function createWriteLeasesRouter({ db }) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD' &&
            (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
            return res.status(400).json({ code: 'invalid_write_lease', error: 'A JSON object body is required' });
        }
        next();
    });
    const handle = fn => (req, res, next) => {
        try { fn(requireLeases(db), req, res); }
        catch (error) { if (!sendLeaseError(res, error)) next(error); }
    };
    router.get('/', handle((leases, req, res) => res.json({ leases: leases.inspect(req.query) })));
    router.post('/', handle((leases, req, res) => res.status(201).json({ lease: leases.acquire(req.body, req.body) })));
    router.patch('/', handle((leases, req, res) => res.json({ lease: leases.renew(req.body?.token, req.body?.ttl_ms) })));
    router.delete('/', handle((leases, req, res) => {
        const { token, request_id } = req.body;
        if (request_id == null) return res.json({ success: leases.release(token) });
        if (token != null) {
            throw Object.assign(new Error('Pass either token or request_id, not both'), { code: 'invalid_write_lease', status: 400 });
        }
        // For a caller that never received the POST's answer, so it has no token.
        res.json({ success: true, released: leases.releaseRequest(request_id) });
    }));
    return router;
};
