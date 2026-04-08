/**
 * Broadcast Route
 * Cortex artifact broadcast relay — mounted at /api/broadcast.
 */
const express = require('express');

function createBroadcastRouter({ io }) {
    const router = express.Router();

    router.post('/', (req, res) => {
        const { type, payload } = req.body;
        if (!type || !payload) return res.status(400).json({ error: 'type and payload are required' });

        console.log(`[Cortex] Received broadcast: ${type}`);
        console.log(`[Cortex] Payload:`, JSON.stringify(payload, null, 2).slice(0, 500));

        const artifact = { type: payload.artifact_type, data: payload.content };
        io.emit('cortex-artifact', artifact);
        console.log(`[WS] Emitted cortex-artifact: ${artifact.type} to ${io.engine.clientsCount} clients`);

        res.json({
            success: true, received: type, artifact_type: payload.artifact_type,
            clients: io.engine.clientsCount, timestamp: new Date().toISOString()
        });
    });

    return router;
}

module.exports = createBroadcastRouter;
