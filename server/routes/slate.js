/**
 * Slate lifecycle read surface: GET /api/slate/lifecycle.
 *
 * One route, one read, no mutation: the cockpit's answer to "which stage is
 * today's slate sitting in, and for how long". Praxis remains the only writer
 * of the schedule; see services/slate-lifecycle.js for why this reads the
 * schedule file rather than the agent-tool bridge (that tool returns a
 * rendered markdown table, not data).
 *
 * The route never fails the request on an unreadable schedule: `available:
 * false` with a reason is the honest answer, and a 500 here would take the
 * task board's strip down with it.
 */
const express = require('express');

const { readSlateLifecycle } = require('../services/slate-lifecycle');

module.exports = function createSlateRouter({ readLifecycle = readSlateLifecycle } = {}) {
    const router = express.Router();

    router.get('/lifecycle', (_req, res) => {
        const lifecycle = readLifecycle({ now: new Date() });
        res.json({ at: new Date().toISOString(), ...lifecycle });
    });

    return router;
};
