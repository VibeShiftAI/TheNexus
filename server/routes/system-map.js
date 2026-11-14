/**
 * System Map: one read-only route that serves the generated fleet map from
 * the shared-mind vault (`system-map/system-map.json`, written by the Praxis
 * generator, `npm run system-map` in Praxis) to the dashboard's System Map
 * page. The file is read from disk on every request, so the page always shows
 * the map that is in the vault now. Nothing here writes, to the vault or
 * anywhere else, and every method other than GET is refused.
 *
 * The route sets no size limit of its own: the map is written by our own
 * generator and is served whole. Each request reads the file into memory and
 * parses it before sending, so what a request costs grows with the file
 * (about 1.4 MB when this was written). What is guarded is the cause a limit
 * would stand in for: the path must be a regular file (a pipe or device is
 * never opened, so a request cannot hang on one), and the bytes must parse as
 * a map before any of them are sent. A file too large for Node to read or to
 * hold as one string fails inside those same two steps and is answered 500
 * like any other unreadable or invalid map.
 *
 * The map lists public hostnames and local ports, so the legacy `local_user`
 * stub is not enough to read it. A request needs one of the operator proofs
 * the rest of Nexus already trusts (document-decision-authority.js): a
 * verified Cloudflare Access session (the tunnel browser, the phone shell,
 * the travel shell), the local operator session of the Mac app or local
 * Chrome, or the operator credential for an operator tool. Anything else,
 * executors and other local processes included, is answered 401 with no map
 * content. The document executor credential is refused: it is scoped to
 * recording a document approval.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { vaultRoot } = require('../lib/vault-paths');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');

const OPERATORS = new Set(['access_user', 'access_device', 'operator_credential']);
const MAP_FILE = path.join('system-map', 'system-map.json');

module.exports = function createSystemMapRouter({
    // Resolved per request so a vault root changed in the environment is honoured.
    vaultPath = () => vaultRoot(),
    authorize = createDocumentDecisionAuthority(),
} = {}) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('Vary', 'Accept-Encoding');
        next();
    });

    router.get('/', async (req, res) => {
        let auth;
        try {
            auth = await authorize(req);
        } catch {
            auth = { ok: false, status: 503, code: 'operator_check_unavailable' };
        }
        if (!auth?.ok) {
            // Only a check that could not run is worth retrying; a credential this
            // host does not accept is a refusal like any other.
            if (auth?.status === 503 && auth.code !== 'operator_credential_unconfigured') {
                return res.status(503).json({ error: 'Your sign-in could not be checked just now. Try again in a moment.', code: auth.code || 'operator_check_unavailable' });
            }
            return res.status(401).json({ error: 'Sign in to Nexus as Robert to see the system map.', code: 'sign_in_required' });
        }
        if (!OPERATORS.has(auth.actor?.authority)) {
            return res.status(403).json({ error: 'This credential cannot read the system map.', code: 'operator_required' });
        }

        const root = typeof vaultPath === 'function' ? vaultPath() : vaultPath;
        const file = path.join(root, MAP_FILE);
        let bytes;
        try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile()) throw Object.assign(new Error('the map path is not a regular file'), { code: 'EINVAL' });
            bytes = await fs.promises.readFile(file);
        } catch (err) {
            if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                return res.status(404).json({ error: 'No system map has been generated yet. Run npm run system-map in Praxis.', code: 'system_map_missing' });
            }
            console.warn(`[SystemMap] map file unreadable (${err.code || 'error'})`);
            return res.status(500).json({ error: 'The system map file could not be read.', code: 'system_map_unreadable' });
        }
        // Serve the vault's bytes as they are, but only once they parse as a
        // map: a truncated or foreign file is reported, never rendered.
        try {
            const map = JSON.parse(bytes.toString('utf8'));
            if (!map || typeof map !== 'object' || typeof map.generatedAt !== 'string' || typeof map.factsHash !== 'string'
                || !Array.isArray(map.nodes) || !Array.isArray(map.edges)) throw new Error('shape');
        } catch {
            console.warn('[SystemMap] map file is not a valid system map');
            return res.status(500).json({ error: 'The system map file in the vault is not a valid map. Rebuild it with npm run system-map in Praxis.', code: 'system_map_invalid' });
        }

        res.type('application/json; charset=utf-8');
        // About 1.3 MB of JSON; a phone on the tunnel gets it compressed.
        if (/\bgzip\b/i.test(req.get('accept-encoding') || '')) {
            try {
                const packed = await new Promise((resolve, reject) => zlib.gzip(bytes, (err, out) => (err ? reject(err) : resolve(out))));
                res.set('Content-Encoding', 'gzip');
                return res.send(packed);
            } catch {
                // fall through to the plain bytes
            }
        }
        return res.send(bytes);
    });

    router.all('/', (_req, res) => {
        res.set('Allow', 'GET');
        res.status(405).json({ error: 'The system map is read-only.', code: 'read_only' });
    });

    return router;
};
