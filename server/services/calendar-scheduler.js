/**
 * Calendar Scheduler Service
 * Polls the calendar_events table every minute and triggers Praxis for any events
 * starting right now.
 */
const http = require('http');

let dbRef = null;
let intervalId = null;

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

async function checkUpcomingEvents() {
    if (!dbRef) return;
    
    // Check events scheduled for today
    const now = new Date();
    // Start of day
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    // End of day
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    
    const events = await dbRef.getCalendarEvents(startOfDay, endOfDay);
    
    events.forEach(event => {
        if (event.status !== 'scheduled') return; // Only process scheduled
        
        const startTime = new Date(event.start_time);
        const timeDiffMs = startTime.getTime() - now.getTime();
        
        // If event is starting within the next minute (or is up to 5 min late but still scheduled)
        if (timeDiffMs <= 60000 && timeDiffMs >= -300000) {
            notifyPraxis(event);
        }
    });
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

module.exports = { start, stop };
