/**
 * Presence — "last active location" for the operator.
 *
 * Every dashboard client (web tab, Tauri desktop app, laptop, Studio) reports
 * a heartbeat when it sees REAL user input (pointer/keys/focus — throttled
 * client-side). The most recent reporter is the operator's active device, and
 * voice announcements auto-play only there.
 *
 * Why (2026-07-17): Robert approved the morning schedule on his laptop and
 * the "Engage" announcement came out of the Mac Studio — twice, overlapping —
 * because the Studio's desktop app AND an open web tab were both connected
 * clients, while the laptop (sitting on the inbox route) stayed silent.
 *
 * In-memory only: a restart forgets the active client, and clients fail open
 * to their local visible+focused check until the next heartbeat lands.
 */
const express = require('express');

function createPresenceRouter() {
    const router = express.Router();
    let lastActive = null; // { clientId, label, at }

    router.post('/client-activity', (req, res) => {
        const { clientId, label } = req.body || {};
        if (!clientId || typeof clientId !== 'string') {
            return res.status(400).json({ error: 'clientId is required' });
        }
        lastActive = {
            clientId,
            label: typeof label === 'string' ? label.slice(0, 80) : undefined,
            at: Date.now(),
        };
        res.json({ ok: true });
    });

    router.get('/active-client', (_req, res) => {
        res.json({ active: lastActive });
    });

    return router;
}

module.exports = createPresenceRouter;
