/**
 * Push Notification Routes
 * Token registration, unregistration, listing, and test notifications.
 */
const express = require('express');

function createPushRouter({ db, pushService }) {
    const router = express.Router();

    // POST register token
    router.post('/register', async (req, res) => {
        const { token, deviceId, platform, label } = req.body;
        if (!token) return res.status(400).json({ error: 'token is required' });
        if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
            return res.status(400).json({ error: 'Invalid Expo push token format' });
        }
        try {
            const result = await db.registerPushToken({ token, deviceId: deviceId || null, platform: platform || 'android', label: label || null });
            if (!result) return res.status(500).json({ error: 'Failed to register token' });
            console.log(`[Push] Token registered: ${token.substring(0, 30)}... (${result.created ? 'new' : 'updated'})`);
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(500).json({ error: 'Failed to register push token' });
        }
    });

    // DELETE unregister token
    router.delete('/unregister', async (req, res) => {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'token is required' });
        try {
            const success = await db.unregisterPushToken(token);
            console.log(`[Push] Token unregistered: ${token.substring(0, 30)}...`);
            res.json({ success });
        } catch (error) {
            res.status(500).json({ error: 'Failed to unregister push token' });
        }
    });

    // GET list tokens
    router.get('/tokens', async (req, res) => {
        try {
            const tokens = await db.getAllPushTokens();
            const safeTokens = tokens.map(t => ({ ...t, token: t.token.substring(0, 25) + '...', tokenFull: undefined }));
            res.json({ tokens: safeTokens, count: tokens.length });
        } catch (error) {
            res.status(500).json({ error: 'Failed to list push tokens' });
        }
    });

    // POST test notification
    router.post('/test', async (req, res) => {
        const { title, body, data } = req.body;
        try {
            const result = await pushService.notify({
                title: title || '🧪 Test Notification',
                body: body || 'This is a test push notification from The Nexus',
                data: { type: 'test', ...data }, channelId: 'nexus-default',
            });
            res.json({ success: true, ...result });
        } catch (error) {
            res.status(500).json({ error: 'Failed to send test notification' });
        }
    });

    return router;
}

module.exports = createPushRouter;
