const express = require('express');

module.exports = function createCalendarRouter({ db }) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const { start, end } = req.query;
            const events = await db.getCalendarEvents(start, end);
            res.json(events);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/', async (req, res) => {
        try {
            const event = await db.createCalendarEvent(req.body);
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
