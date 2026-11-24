const express = require('express');

module.exports = function createOutcomeSpeechRouter({ db }) {
    const router = express.Router();
    router.get('/', (_req, res) => {
        res.set('Cache-Control', 'no-store').json(db.pendingOutcomeSpeech());
    });
    router.post('/:id/claim', (req, res) => {
        const token = req.body?.token;
        if (typeof token !== 'string' || !token) return res.sendStatus(400);
        res.json({ claimed: db.claimOutcomeSpeech(req.params.id, token) });
    });
    router.post('/:id/release', (req, res) => {
        const token = req.body?.token;
        if (typeof token !== 'string' || !token) return res.sendStatus(400);
        db.releaseOutcomeSpeech(req.params.id, token);
        res.json({ ok: true });
    });

    return router;
};
