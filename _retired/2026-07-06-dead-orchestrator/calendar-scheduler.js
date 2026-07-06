/**
 * Calendar Scheduler Service
 * Polls the calendar_events table every minute and triggers Praxis for any events
 * starting right now.
 */
const http = require('http');
const {
    resolveModelAssignment,
    recordModelExecutionSnapshot,
    writeModelSystemMessage
} = require('./model-control');

let dbRef = null;
let intervalId = null;
let notifyPraxisImpl = notifyPraxis;

function notifyPraxis(event) {
    const payload = JSON.stringify(event);
    const options = {
        hostname: '127.0.0.1',
        port: 54322,
        path: '/calendar-event',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
            console.log(`[CalendarScheduler] Dispatched event ${event.id} to Praxis successfully.`);
            // Update status to 'in_progress'
            if (dbRef) {
                dbRef.updateCalendarEvent(event.id, { status: 'in_progress', updated_at: new Date().toISOString() });
            }
        }
    });

    req.on('error', (e) => {
        console.error(`[CalendarScheduler] Error pinging Praxis for event ${event.id}:`, e.message);
    });

    req.write(payload);
    req.end();
}

function shouldDispatchCalendarEvent(event, now = new Date()) {
    if (event.status !== 'scheduled') return false;
    if (String(event.event_type || '').startsWith('local_llm:')) return false;

    const startTime = new Date(event.start_time);
    const timeDiffMs = startTime.getTime() - now.getTime();

    return timeDiffMs <= 60000 && timeDiffMs >= -300000;
}

async function dispatchCalendarEvent(db, event) {
    // Model-control resolution ENRICHES a dispatch (resolved model + snapshot)
    // but must NEVER gate it. Executor-backed tasks (claude-code / antigravity /
    // codex) carry their own model, so if resolution throws — e.g. a config gap
    // leaves the default `alias:local_default` pointing at nothing and no local
    // model is registered — we still hand the task to Praxis, just without a
    // modelOverride. Previously such a throw was caught one level up and the
    // event was retried-and-failed forever, silently blocking ALL scheduled
    // dispatch. Degrade gracefully instead of dropping the task on the floor.
    let resolved = null;
    try {
        resolved = await resolveModelAssignment(db, {
            requestedAssignment: event.model_assignment,
            model_assignment: event.model_assignment,
            projectId: event.project_id,
            project_id: event.project_id,
            calendarEventId: event.id,
            role: 'scheduled_activity'
        });
        await recordModelExecutionSnapshot(db, resolved, {
            project_id: event.project_id || null,
            task_id: event.task_id || null,
            calendar_event_id: event.id
        });

        if (resolved.localOnlyActive || resolved.fallbackUsed) {
            const reason = resolved.localOnlyActive
                ? `local-only mode${resolved.localOnlyReason ? ` (${resolved.localOnlyReason})` : ''}`
                : `fallback (${resolved.fallbackReason || 'requested model unavailable'})`;
            await writeModelSystemMessage(
                db,
                null,
                `Model control redirected scheduled event "${event.title}" to ${resolved.label || resolved.apiModelId} via ${reason}.`,
                { modelControl: { resolved, modelAssignment: event.model_assignment, calendarEventId: event.id } }
            );
        }
    } catch (err) {
        console.warn(
            `[CalendarScheduler] Model-control resolution failed for event "${event.title}" (${event.id}); dispatching without model override:`,
            err && err.message ? err.message : err
        );
        resolved = null;
    }

    return notifyPraxisImpl({
        ...event,
        modelAssignment: event.model_assignment,
        resolvedModel: resolved,
        ...(resolved ? {
            modelOverride: {
                provider: resolved.provider,
                apiModelId: resolved.apiModelId,
                parameters: resolved.parameters || {}
            }
        } : {})
    });
}

async function checkUpcomingEvents(db = dbRef, now = new Date()) {
    if (!db) return;
    
    // Check events scheduled for today
    // Start of day
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    // End of day
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    
    const events = await db.getCalendarEvents(startOfDay, endOfDay);
    
    await Promise.all(events.map(async event => {
        // If event is starting within the next minute (or is up to 5 min late but still scheduled)
        if (shouldDispatchCalendarEvent(event, now)) {
            // Per-event isolation: a single event's dispatch failure (e.g. model
            // control throwing "No active local model" when the local LLM is
            // momentarily down) must NOT reject the whole Promise.all and surface
            // as an unhandled rejection — which previously added event-loop noise
            // ahead of a supervisor restart. The event stays `scheduled`, so the
            // next poll tick retries it once the model is back.
            try {
                await dispatchCalendarEvent(db, event);
            } catch (err) {
                console.error(
                    `[CalendarScheduler] Dispatch failed for event "${event.title}" (${event.id}); will retry next tick:`,
                    err && err.message ? err.message : err
                );
            }
        }
    }));
}

function start(db) {
    dbRef = db;
    if (intervalId) clearInterval(intervalId);
    
    console.log('[CalendarScheduler] Starting calendar event polling interval...');
    // Check every minute
    intervalId = setInterval(checkUpcomingEvents, 60000);
    // Initial check after 5 seconds
    setTimeout(checkUpcomingEvents, 5000);
}

function stop() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

function __setNotifyPraxisForTests(fn) {
    notifyPraxisImpl = fn || notifyPraxis;
}

module.exports = { start, stop, shouldDispatchCalendarEvent, checkUpcomingEvents, dispatchCalendarEvent, __setNotifyPraxisForTests };
