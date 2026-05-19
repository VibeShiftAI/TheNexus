const express = require('express');
const http = require('http');
const createCalendarRouter = require('../routes/calendar');

function listen(app) {
    return new Promise((resolve) => {
        const server = http.createServer(app);
        server.listen(0, () => resolve(server));
    });
}

describe('calendar route', () => {
    test('returns 500 when database insert fails without an event', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/calendar', createCalendarRouter({
            db: {
                createCalendarEvent: async () => null,
            },
        }));

        const server = await listen(app);
        try {
            const { port } = server.address();
            const response = await fetch(`http://127.0.0.1:${port}/api/calendar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Broken event' }),
            });
            const body = await response.json();

            expect(response.status).toBe(500);
            expect(body.error).toMatch(/Failed to create calendar event/);
        } finally {
            server.close();
        }
    });
});
