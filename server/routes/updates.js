/**
 * Travel-app self-update feed — /api/updates
 *
 * Serves the Tauri updater manifest (latest.json) and the signed Windows
 * installer for the travel shell, straight off this box through the
 * Cloudflare tunnel. The whole nexus.vibeshiftai.com hostname sits behind
 * Cloudflare Access, so the edge has already authorized the request (the
 * app carries the Access service token) before it reaches us — this router
 * just hands back files. The installer's signature is verified by the app
 * against its baked-in public key, so serving over the tunnel is safe even
 * though we do no auth here ourselves.
 *
 * Files live in desktop/updates/ (gitignored), staged by
 * scripts/stage-travel-update.sh after each CI build.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const UPDATES_DIR = path.resolve(__dirname, '..', '..', 'desktop', 'updates');

// Only these may be fetched — no arbitrary path from the URL.
const ALLOWED = /^[A-Za-z0-9._-]+\.(json|exe|sig)$/;

function createUpdatesRouter() {
    const router = express.Router();

    const serve = (req, res) => {
        const name = req.params.file || 'latest.json';
        if (!ALLOWED.test(name)) {
            return res.status(400).json({ error: 'bad update file name' });
        }
        // basename guard on top of the whitelist regex — belt and suspenders.
        const full = path.join(UPDATES_DIR, path.basename(name));
        if (!fs.existsSync(full)) {
            // A missing manifest is the normal "no updates published yet"
            // state; the updater treats a 404 as "up to date".
            return res.status(404).json({ error: 'not found' });
        }
        if (name.endsWith('.json')) res.type('application/json');
        else if (name.endsWith('.exe')) res.type('application/octet-stream');
        else res.type('text/plain');
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(full);
    };

    router.get('/latest.json', serve);
    router.get('/:file', serve);

    return router;
}

module.exports = createUpdatesRouter;
