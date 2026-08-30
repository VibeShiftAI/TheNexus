/**
 * Activity event stream — /api/ag/events
 *
 * The durable operational-event log behind the dashboard's Recent Activity
 * feed. Praxis publishes EVERY operational event here (ops-events.ts) and
 * separately decides which of them are worth a line in the chat; this router
 * is the destination that makes "it's in the activity log" true.
 *
 * History: Praxis has POSTed to /api/ag/events since the Antigravity
 * extension days, but the route was dropped when that extension was retired.
 * The publisher is fire-and-forget and never checked response.ok, so the
 * relay silently 404'd from 2026-06-28 onward. Any change here must keep the
 * POST shape byte-compatible with what Praxis sends.
 */
const express = require('express');

function createActivityEventsRouter({ db, io }) {
    const router = express.Router();

    // Praxis → Nexus relay. Fire-and-forget on the caller's side, so answer
    // fast and never make the publisher wait on a broadcast.
    router.post('/events', async (req, res) => {
        try {
            const saved = await db.recordAgEvent(req.body || {});
            if (!saved) return res.status(400).json({ error: 'event_type and title are required' });

            // Live-push so the feed updates without a poll. Best-effort: a
            // socket failure must not fail the write that already landed.
            try {
                io?.emit('activity:event', {
                    id: saved.id,
                    event_type: req.body.event_type,
                    severity: req.body.severity || 'info',
                    title: req.body.title,
                    message: req.body.message ?? null,
                    task_id: req.body.task_id ?? null,
                    source: req.body.source ?? 'praxis',
                    metadata: req.body.metadata ?? {},
                    requires_action: req.body.requires_action ? 1 : 0,
                    created_at: new Date().toISOString(),
                });
            } catch (err) {
                console.warn('[ActivityEvents] socket broadcast failed:', err.message);
            }

            res.status(201).json({ success: true, id: saved.id });
        } catch (error) {
            res.status(500).json({ error: 'Failed to record event: ' + error.message });
        }
    });

    router.get('/events', async (req, res) => {
        try {
            res.json(await db.getAgEvents({
                limit: req.query.limit,
                since: req.query.since || null,
                severity: req.query.severity || null,
            }));
        } catch (error) {
            res.status(500).json({ error: 'Failed to read events: ' + error.message });
        }
    });

    return router;
}

module.exports = createActivityEventsRouter;
