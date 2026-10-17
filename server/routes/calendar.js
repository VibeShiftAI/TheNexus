const express = require('express');
const followUps = require('../services/followup-schedule');

module.exports = function createCalendarRouter({ db, now = () => new Date() }) {
    const router = express.Router();
    const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

    /**
     * Put a prepared follow-up on today's calendar after the last planned
     * task. The event is what Praxis's calendar poller fires, through the
     * ordinary dispatch and QA gates; this route only writes the row. One
     * pending event per task: a second request answers 409 with the existing
     * event rather than scheduling the task twice.
     */
    router.post('/follow-ups', async (req, res) => {
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Use the follow-up control from your Nexus session.' });
        const body = req.body || {};
        const taskId = body.taskId;
        if (!validId(taskId) || Object.keys(body).some(key => key !== 'taskId')) {
            return res.status(400).json({ error: 'Refresh the follow-up list and submit its current task.' });
        }
        try {
            const task = await db.getTask(taskId);
            if (!task) return res.status(404).json({ error: 'Task not found on the board; nothing was scheduled.' });
            if (followUps.taskClosed(task)) {
                return res.status(409).json({ error: `Task is ${task.status || 'closed'}; create a separate follow-up task instead of rescheduling finished work.` });
            }
            const project = task.project_id ? await db.getProject(task.project_id) : null;
            const workspace = typeof project?.path === 'string' ? project.path.trim() : '';
            if (!workspace || /[\r\n]/.test(workspace)) {
                return res.status(422).json({ error: 'This task’s project has no workspace path, so Praxis could not run it from the calendar. Set the project path first.' });
            }
            const events = await db.getCalendarEvents(undefined, undefined, { eventType: 'praxis_task' });
            const pending = followUps.pendingEventFor(events, taskId);
            if (pending) {
                return res.status(409).json({ error: 'This task already has a pending calendar event; it is on the schedule.', event: pending });
            }
            const slot = followUps.planFollowUpSlot(events, now());
            const event = await db.createCalendarEvent(followUps.followUpEvent({ task, workspace, slot }));
            if (!event || event.status !== 'scheduled') {
                return res.status(500).json({ error: 'The calendar did not confirm the new event. Refresh before trying again.' });
            }
            res.status(201).json({ event, after: slot.anchor });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

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
            if (!event) return res.status(500).json({ error: 'Failed to update calendar event' });
            res.json(event);
        } catch (error) {
            if (error.code === 'CALENDAR_STATE_CHANGED') return res.status(409).json({ error: error.message, current: error.current });
            if (error.code === 'CALENDAR_INVALID_EXPECTATION') return res.status(400).json({ error: error.message });
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
                    const updated = await db.updateCalendarEvent(event.id, req.body);
                    if (!updated) return res.status(500).json({ error: 'Failed to update calendar event' });
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
