/**
 * AG Events Routes
 * Antigravity event stream — mounted at /api/ag.
 */
const express = require('express');

function createAgEventsRouter({ db, io, pushService }) {
    const router = express.Router();

    // POST ingest AG event — /api/ag/events
    router.post('/events', async (req, res) => {
        const { event_type, severity, title, message, task_id, source, metadata, requires_action } = req.body;
        if (!event_type || !title) return res.status(400).json({ error: 'event_type and title are required' });
        try {
            const event = await db.recordAgEvent({
                event_type, severity: severity || 'info', title, message: message || null,
                task_id: task_id || null, source: source || 'extension', metadata: metadata || {},
                requires_action: requires_action || false
            });
            if (event) {
                io.emit('ag-event', event);
                console.log(`[AG Stream] ${severity || 'info'}: ${title} → ${io.engine.clientsCount} clients`);
                if ((severity === 'critical' || severity === 'warning') || requires_action) {
                    pushService.notifySystemAlert(event).catch(err => console.warn('[Push] AG event notification failed:', err.message));
                }
            }
            res.json({ success: true, event });
        } catch (error) {
            res.status(500).json({ error: 'Failed to record event' });
        }
    });

    // GET recent events — /api/ag/events
    router.get('/events', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            res.json({ events: await db.getRecentAgEvents(Math.min(limit, 200)) });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch events' });
        }
    });

    // PUT mark event actioned — /api/ag/events/:id/action
    router.put('/events/:id/action', async (req, res) => {
        try {
            const success = await db.markAgEventActioned(req.params.id);
            if (success) io.emit('ag-event-actioned', { id: parseInt(req.params.id) });
            res.json({ success });
        } catch (error) {
            res.status(500).json({ error: 'Failed to mark event actioned' });
        }
    });

    return router;
}

module.exports = createAgEventsRouter;
