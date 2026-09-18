/**
 * Member commitment queue: GET /api/member-commitments.
 *
 * Read-only projection over the member-memory ledger (db/member-commitments.js).
 * Scope is always explicit: one member, one project, or the operator aggregate
 * across every member and project. A ledger that cannot be read answers 503
 * with status "unavailable" rather than an empty, reassuring list.
 */
const express = require('express');

const STRING_FIELDS = ['scope', 'member_id', 'project_id', 'status', 'owner'];
const NUMBER_FIELDS = ['limit', 'before_seq'];

function createMemberCommitmentsRouter({ db }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const allowed = new Set([...STRING_FIELDS, ...NUMBER_FIELDS, '_cb']);
            if (Object.entries(req.query).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
                return res.status(400).json({ error: 'Invalid commitment query fields' });
            }
            const options = {};
            for (const key of STRING_FIELDS) if (req.query[key]) options[key] = req.query[key];
            for (const key of NUMBER_FIELDS) {
                if (req.query[key] === undefined) continue;
                if (!/^[1-9]\d*$/.test(req.query[key])) return res.status(400).json({ error: `${key} must be a positive integer` });
                options[key] = Number(req.query[key]);
            }
            const result = await db.listMemberCommitments(options);
            res.status(result.status === 'unavailable' ? 503 : 200).json(result);
        } catch (error) {
            const status = [400, 404, 409].includes(error.status) ? error.status : 500;
            res.status(status).json({ error: status === 500 ? 'Failed to list member commitments' : error.message });
        }
    });

    return router;
}

module.exports = createMemberCommitmentsRouter;
