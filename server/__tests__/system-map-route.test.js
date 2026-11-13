const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const createRouter = require('../routes/system-map');

const MAP = {
    _generated: 'GENERATED: praxis-system-map; do not edit.',
    generatedAt: '2026-11-13T18:21:16.068Z',
    factsHash: '9d77d6536e79b27a',
    nodes: [{ id: 'nexus', name: 'The Nexus', kind: 'system', level: 0, attrs: {} }],
    edges: [],
    checks: [],
    catalogs: { tunnelIngress: [{ hostname: 'nexus.example.test', service: 'http://localhost:3000' }] },
};

describe('system map route', () => {
    let server, url, vault, auth, authorize;
    const snapshot = dir => fs.readdirSync(dir, { recursive: true }).sort().map(name => {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.isFile() ? stat.size : 'dir'}:${stat.mtimeMs}`;
    });
    async function start(options = {}) {
        const app = express(); app.use(express.json());
        // The same stub server.js stamps on every request: it is not a credential.
        app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
        app.use('/api/system-map', createRouter({ vaultPath: () => vault, ...options }));
        server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${server.address().port}/api/system-map`;
    }
    beforeEach(() => {
        vault = fs.mkdtempSync(path.join(os.tmpdir(), 'system-map-route-'));
        fs.mkdirSync(path.join(vault, 'system-map'));
        fs.writeFileSync(path.join(vault, 'system-map', 'system-map.json'), JSON.stringify(MAP));
        auth = { ok: true, actor: { id: 'local_user', authority: 'access_user' } };
        authorize = async () => auth;
    });
    afterEach(async () => {
        if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); server = null; }
        fs.rmSync(vault, { recursive: true, force: true });
    });

    test('serves the bytes that are in the vault now to a verified operator', async () => {
        await start({ authorize });
        const first = await fetch(url);
        expect(first.status).toBe(200);
        expect(first.headers.get('cache-control')).toBe('no-store');
        expect(first.headers.get('content-type')).toMatch(/^application\/json/);
        expect(await first.json()).toEqual(MAP);
        // A rebuilt map is served on the next request: nothing is cached.
        const rebuilt = { ...MAP, generatedAt: '2026-11-14T09:00:00.000Z', factsHash: 'aaaaaaaaaaaaaaaa' };
        fs.writeFileSync(path.join(vault, 'system-map', 'system-map.json'), JSON.stringify(rebuilt));
        expect((await (await fetch(url)).json()).factsHash).toBe('aaaaaaaaaaaaaaaa');
    });

    test('compresses for a client that accepts gzip and sends plain bytes otherwise', async () => {
        await start({ authorize });
        const raw = await new Promise((resolve, reject) => http.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        }).on('error', reject));
        expect(raw.res.headers['content-encoding']).toBe('gzip');
        expect(JSON.parse(zlib.gunzipSync(raw.body).toString('utf8'))).toEqual(MAP);
        const plain = await new Promise((resolve, reject) => http.get(url, { headers: { 'Accept-Encoding': 'identity' } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        }).on('error', reject));
        expect(plain.res.headers['content-encoding']).toBeUndefined();
        expect(plain.body.equals(fs.readFileSync(path.join(vault, 'system-map', 'system-map.json')))).toBe(true);
    });

    test('refuses a request with no operator proof, using the real authority, and leaks no map content', async () => {
        await start(); // default authorize: the real document-decision authority
        for (const headers of [
            {},
            { Authorization: 'Bearer local-dev-token' },
            { Cookie: 'nexus_local_operator=forged', 'X-Nexus-Local-Proof': 'A'.repeat(43) },
            { 'Cf-Access-Jwt-Assertion': 'not.a.token' },
            { 'X-Praxis-Bridge-Token': 'anything' },
        ]) {
            const response = await fetch(url, { headers });
            const text = await response.text();
            expect([401, 503]).toContain(response.status);
            expect(text).not.toContain('factsHash');
            expect(text).not.toContain('nexus.example.test');
        }
        const bare = await fetch(url);
        expect(bare.status).toBe(401);
        expect((await bare.json()).code).toBe('sign_in_required');
    });

    test('refuses a request the server stamped no user on', async () => {
        const app = express();
        app.use('/api/system-map', createRouter({ vaultPath: () => vault }));
        server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/system-map`);
        expect(response.status).toBe(401);
    });

    test('refuses the document executor credential and reports an unavailable check', async () => {
        await start({ authorize });
        auth = { ok: true, actor: { id: 'local_user', authority: 'document_executor_credential' } };
        expect((await fetch(url)).status).toBe(403);
        auth = { ok: false, status: 403, code: 'operator_required' };
        expect((await fetch(url)).status).toBe(401);
        auth = { ok: false, status: 503, code: 'operator_check_unavailable' };
        expect((await fetch(url)).status).toBe(503);
    });

    test('answers 503, not the map, when the operator check itself throws', async () => {
        await start({ authorize: async () => { throw new Error('boom'); } });
        const response = await fetch(url);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('factsHash');
    });

    test('is read-only: every other method is refused and a read changes nothing in the vault', async () => {
        await start({ authorize });
        const before = snapshot(vault);
        expect((await fetch(url)).status).toBe(200);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: [] }) });
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
        }
        expect((await fetch(`${url}/system-map.json`)).status).toBe(404);
        expect((await fetch(`${url}/..%2f..%2fSOUL.md`)).status).toBe(404);
        expect(snapshot(vault)).toEqual(before);
    });

    test('names a missing or invalid map instead of rendering one', async () => {
        await start({ authorize });
        fs.writeFileSync(path.join(vault, 'system-map', 'system-map.json'), '{"generatedAt":"2026-11-13T18:21:16.068Z","nodes":[');
        const invalid = await fetch(url);
        expect(invalid.status).toBe(500);
        expect((await invalid.json()).code).toBe('system_map_invalid');
        fs.rmSync(path.join(vault, 'system-map'), { recursive: true });
        const missing = await fetch(url);
        expect(missing.status).toBe(404);
        expect((await missing.json()).code).toBe('system_map_missing');
    });
});
