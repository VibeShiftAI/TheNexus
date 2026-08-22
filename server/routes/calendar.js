const express = require('express');

module.exports = function createCalendarRouter({ db }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const { start, end, project_id, event_type, series_id } = req.query;
            const events = await db.getCalendarEvents(start, end, {
                projectId: project_id ? String(project_id) : undefined,
                eventType: event_type ? String(event_type) : undefined,
                seriesId: series_id ? String(series_id) : undefined,
            });
            res.json(events);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Stakeholder review meetings — one-off or a materialized recurring
    // series (weekly/biweekly/monthly, ≤52 occurrences) sharing a series_id.
    // event_type defaults to 'stakeholder_meeting' (never dispatched by Praxis).
    router.post('/series', async (req, res) => {
        try {
            const body = req.body || {};
            if (!body.title || !body.start_time) {
                return res.status(400).json({ error: 'title and start_time are required' });
            }
            if (body.recurrence && !['weekly', 'biweekly', 'monthly'].includes(body.recurrence)) {
                return res.status(400).json({ error: 'recurrence must be weekly, biweekly, or monthly' });
            }
            const created = await db.createCalendarSeries({
                ...body,
                event_type: body.event_type || 'stakeholder_meeting',
            });
            if (!created) return res.status(400).json({ error: 'Failed to create meeting series (check start_time)' });
            res.status(201).json(created);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.delete('/series/:seriesId', async (req, res) => {
        try {
            const deleted = await db.deleteCalendarSeries(req.params.seriesId, req.query.from ? String(req.query.from) : undefined);
            res.json({ deleted });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/', async (req, res) => {
        try {
            const event = await db.createCalendarEvent(req.body);
            if (!event) {
                return res.status(500).json({ error: 'Failed to create calendar event' });
            }
            res.status(201).json(event);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.put('/:id', async (req, res) => {
        try {
            const event = await db.updateCalendarEvent(req.params.id, req.body);
            res.json(event);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Accept PUT with ?task_id query param from webhook
    router.put('/', async (req, res) => {
        try {
            const { task_id } = req.query;
            if (task_id) {
                // Fetch the event with this task_id
                const events = await db.getCalendarEvents(); // Basic fetch, we can filter in JS for now or write a SQL DB method
                const event = events.reverse().find(e => e.task_id === task_id); // Get latest
                if (event) {
                    await db.updateCalendarEvent(event.id, req.body);
                    res.json({ status: 'ok' });
                    return;
                }
            }
            res.status(404).json({ error: "Not found" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.delete('/:id', async (req, res) => {
        try {
            await db.deleteCalendarEvent(req.params.id);
            res.status(204).end();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
