const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const media = require('../services/review-media');
const access = require('./helpers/operator-access');
const { createPresentationService } = require('../services/presentations');
const createPresentationRouter = require('../routes/presentations');
const { createPresentationReceiverApp, receiverConfiguration } = require('../presentation-receiver');

const fetchHttp = global.fetch;
let restoreAccess, fetchSpy, logSpy, warnSpy, workspace, service, controller, receiver, current, rows, previousBlobDir;
const source = { id: 'windows-test', name: 'Travel laptop', platform: 'windows' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = value => new Date(value).toISOString();

function inventory(overrides = {}) {
    return {
        version: 1, sourceDevice: source, observedAt: iso(current), expiresAt: iso(current + 30_000), status: 'available',
        targets: [{ id: 'monitor-1', name: 'TV', sourceDeviceId: source.id, method: 'windows-monitor',
            availability: 'available', observedAt: iso(current), capabilities: ['ambient', 'focus', 'document', 'day-plan'],
            limitations: [], isPrimary: false, bounds: { x: 1920, y: 0, width: 3840, height: 2160, scaleFactor: 1.5 } }],
        limitations: ['Reported by the controller device'], ...overrides,
    };
}

function dbFixture() {
    rows = {
        projects: [{ id: 'p1', name: 'Travel', path: '/private/project', description: 'PRIVATE_PROJECT' }],
        tasks: [
            { id: 't1', name: 'Inspect display', status: 'in_progress', description: 'PRIVATE_BRIEF', inbox: 'PRIVATE_INBOX', metadata: { approval: 'PRIVATE_APPROVAL' }, updated_at: '2026-10-20T10:00:00.000Z' },
            { id: 't2', name: 'Queue report', status: 'todo' },
            { id: 't3', name: 'Finish notes', status: 'completed' },
        ],
        events: [{ id: 'e1', title: 'Review trip', start_time: '2026-10-20T15:00:00.000Z', end_time: '2026-10-20T15:30:00.000Z', status: 'scheduled', description: 'PRIVATE_EVENT', attendees: 'PRIVATE_PEOPLE' }],
        documents: new Map(), revisions: new Map(), assets: new Map(), activity: null,
    };
    return {
        getProjects: async () => rows.projects,
        getTasks: async projectId => projectId === 'p1' ? rows.tasks : [],
        getCalendarEvents: async (start, end) => rows.events.filter(e => e.start_time >= start && e.start_time <= end),
        documentReviews: {
            getDocument: id => rows.documents.get(id),
            getRevision: id => rows.revisions.get(id),
            getRevisionExact: id => rows.revisions.get(id)?.exact ?? null,
            listRevisionAssets: id => rows.assets.get(id) || [],
        },
    };
}

function registerDocument({ mediaType = 'markdown', mimeType = 'text/markdown', bytes = Buffer.from('# Pinned report\n'), id = 'doc-1', revisionId = 'rev-1', assets = true } = {}) {
    const file = path.join(workspace, `${id}.${mediaType}`);
    fs.writeFileSync(file, bytes);
    const contentHash = hash(bytes);
    rows.documents.set(id, { id, title: 'Selected report', path: file, current_revision_id: revisionId, description: 'PRIVATE_DOCUMENT' });
    rows.revisions.set(revisionId, { id: revisionId, document_id: id, content_hash: contentHash, content: mediaType === 'markdown' ? bytes.toString() : null, byte_length: bytes.length, media_type: mediaType, mime_type: mimeType });
    if (assets) rows.assets.set(revisionId, [{ asset_key: 'primary', role: 'primary', path: file, content_hash: contentHash, byte_length: bytes.length, media_type: mediaType, mime_type: mimeType }]);
    return { view: { kind: 'document', documentId: id, revisionId, contentHash }, file, bytes };
}

async function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    });
}

async function request(server, url, { method = 'GET', body, token, signed = server === controller, headers = {} } = {}) {
    const response = await fetchHttp(server.url + url, {
        method, headers: {
            ...(signed ? { 'cf-access-jwt-assertion': access.token() } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
        }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data; try { data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text; } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
}

async function start(view = { kind: 'ambient' }) {
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() })).status).toBe(200);
    const result = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: source.id, targetId: 'monitor-1', view } });
    expect(result.status).toBe(201);
    return result.data;
}

async function pair(view = { kind: 'ambient' }) {
    const enrolled = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'Hotel TV' } });
    expect(enrolled.status).toBe(201);
    const claimed = await request(controller, `/api/presentations/pairings/${enrolled.data.code}/claim`, { method: 'POST', body: { sourceDevice: source, view } });
    expect(claimed.status).toBe(201);
    const poll = await request(receiver, `/receiver/pairings/${enrolled.data.code}`, { token: enrolled.data.pollToken });
    expect(poll.status).toBe(200);
    return { enrolled: enrolled.data, claimed: claimed.data, ...poll.data };
}

beforeEach(async () => {
    current = Date.now();
    const testRoot = path.resolve(__dirname, '../../data/presentation-captures');
    fs.mkdirSync(testRoot, { recursive: true });
    workspace = fs.mkdtempSync(path.join(testRoot, 'test-'));
    previousBlobDir = process.env.NEXUS_REVIEW_BLOB_DIR;
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(workspace, 'review-blobs');
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
        if (url === `${access.issuer}/cdn-cgi/access/certs`) return { ok: true, json: async () => access.jwks };
        return fetchHttp(url, options);
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    service = createPresentationService({ db: dbFixture(), now: () => current, captureRoot: workspace, readActivity: async () => rows.activity });
    const app = express();
    app.use(express.json());
    // The legacy local-user stub must confer no authority on this router.
    app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin' }; next(); });
    app.use('/api/presentations', createPresentationRouter({ service }));
    controller = await listen(app);
    const staticDir = path.join(workspace, 'static');
    fs.mkdirSync(staticDir);
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Presentation</title>');
    fs.writeFileSync(path.join(staticDir, 'cast.html'), '<!doctype html><title>Cast presentation</title>');
    fs.writeFileSync(path.join(staticDir, 'icon.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(staticDir, 'presentation.js'), 'window.presentation = true;');
    receiver = await listen(createPresentationReceiverApp({ service, staticDir }));
});

afterEach(async () => {
    for (const item of [controller, receiver]) if (item) await new Promise(resolve => { item.server.closeAllConnections(); item.server.close(resolve); });
    await service?.close();
    fetchSpy?.mockRestore(); logSpy?.mockRestore(); warnSpy?.mockRestore(); restoreAccess?.();
    if (previousBlobDir === undefined) delete process.env.NEXUS_REVIEW_BLOB_DIR; else process.env.NEXUS_REVIEW_BLOB_DIR = previousBlobDir;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('every controller request requires a fresh verified operator assertion, including device sessions', async () => {
    for (const url of ['/config', '/inventory', '/sessions']) {
        expect((await request(controller, `/api/presentations${url}`, { signed: false })).status).toBe(401);
        expect((await request(controller, `/api/presentations${url}`, { headers: { 'cf-access-jwt-assertion': access.token({ exp: Math.floor(Date.now() / 1000) - 1 }) } })).status).toBe(401);
        const parts = access.token().split('.');
        parts[2] = crypto.randomBytes(256).toString('base64url');
        expect((await request(controller, `/api/presentations${url}`, { headers: { 'cf-access-jwt-assertion': parts.join('.') } })).status).toBe(401);
    }
    expect((await request(controller, '/api/presentations/config', { headers: { 'cf-access-jwt-assertion': access.serviceToken() } })).status).toBe(200);
    expect((await request(controller, '/api/presentations/config', { headers: { 'cf-access-client-id': access.deviceId } })).status).toBe(401);
});

test('inventory validates provenance, bounded targets, unique identity, timestamps, and native method', async () => {
    const bad = [
        inventory({ extra: 'ignored?' }),
        inventory({ sourceDevice: { ...source, platform: 'server' } }),
        inventory({ targets: [{ ...inventory().targets[0], sourceDeviceId: 'another' }] }),
        inventory({ targets: Array(33).fill(inventory().targets[0]) }),
        inventory({ targets: [inventory().targets[0], inventory().targets[0]] }),
        inventory({ observedAt: iso(current + 60_000), expiresAt: iso(current + 90_000) }),
        inventory({ observedAt: iso(current - 60_000), expiresAt: iso(current - 30_000) }),
        inventory({ targets: [{ ...inventory().targets[0], observedAt: iso(current - 60_000) }] }),
        inventory({ targets: [{ ...inventory().targets[0], method: 'paired-browser' }] }),
    ];
    for (const body of bad) expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body })).status).toBe(400);
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() })).status).toBe(200);
    expect((await request(controller, '/api/presentations/inventory')).data).toEqual({ inventories: [inventory()] });
});

test.each([1, 1000, 5000])('Android inventory tolerates %i ms of clock lead without extending server freshness', async clockLead => {
    const phone = { id: 'android-clock-test', name: 'Pixel 9 Pro', platform: 'android' };
    const observedAt = iso(current + clockLead);
    const body = inventory({ sourceDevice: phone, observedAt, expiresAt: iso(current + clockLead + 30_000),
        targets: [{ ...inventory().targets[0], sourceDeviceId: phone.id, method: 'android-presentation', observedAt }] });
    const accepted = await request(controller, '/api/presentations/inventory', { method: 'PUT', body });
    expect(accepted.status).toBe(200);
    expect(accepted.data.observedAt).toBe(observedAt);
    expect(accepted.data.expiresAt).toBe(iso(current + 30_000));
    expect((await request(controller, '/api/presentations/inventory')).data.inventories[0]).toEqual(accepted.data);
    current += 30_000;
    const expired = await request(controller, '/api/presentations/sessions', { method: 'POST', body: {
        sourceDeviceId: phone.id, targetId: 'monitor-1', view: { kind: 'ambient' },
    } });
    expect(expired.status).toBe(409);
    expect(expired.data.code).toBe('stale_inventory');
});

test('inventory still refuses a clock lead beyond the five-second allowance', async () => {
    const body = inventory({ observedAt: iso(current + 5001), expiresAt: iso(current + 35_001) });
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body })).status).toBe(400);
});

test('target selection refuses ambiguous names, unavailable targets, stale inventory and wrong view capabilities', async () => {
    const attempt = targetId => request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: source.id, targetId, view: { kind: 'ambient' } } });
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory({ targets: [inventory().targets[0], { ...inventory().targets[0], id: 'monitor-2' }] }) });
    expect((await attempt('TV')).data.code).toBe('ambiguous_target');
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory({ targets: [{ ...inventory().targets[0], availability: 'disconnected' }] }) });
    expect((await attempt('monitor-1')).data.code).toBe('target_unavailable');
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory({ targets: [{ ...inventory().targets[0], capabilities: ['document'] }] }) });
    expect((await attempt('monitor-1')).data.code).toBe('unsupported_view');
    current += 30_001;
    expect((await attempt('monitor-1')).data.code).toBe('stale_inventory');
});

test('all four projections expose only allowlisted data and immutable selected view', async () => {
    const doc = registerDocument();
    const views = [{ kind: 'ambient' }, { kind: 'focus', mode: 'active' }, { kind: 'day-plan', date: '2026-10-20' }, doc.view];
    for (const view of views) {
        const session = await start(view);
        expect(session.state).toBe('starting');
        const result = await request(controller, `/api/presentations/sessions/${session.id}/view`);
        expect(result.status).toBe(200);
        expect(result.data.session.view).toEqual(view);
        expect(result.data.content.kind).toBe(view.kind);
        expect(JSON.stringify(result.data)).not.toMatch(/PRIVATE_|\/private\/|approval|cookie|path/);
        if (view.kind === 'ambient') expect(result.data.content).toMatchObject({ counts: { active: 1, queued: 1, completed: 1 }, label: expect.stringMatching(/board/i) });
        if (view.kind === 'focus') expect(result.data.content.tasks).toEqual([{ id: 't1', title: 'Inspect display', project: 'Travel', status: 'in_progress', updatedAt: '2026-10-20T10:00:00.000Z' }]);
        if (view.kind === 'day-plan') expect(result.data.content.events).toEqual([{ id: 'e1', title: 'Review trip', startsAt: '2026-10-20T15:00:00.000Z', endsAt: '2026-10-20T15:30:00.000Z', status: 'scheduled' }]);
        if (view.kind === 'document') expect(result.data.content).toMatchObject({ content: '# Pinned report\n', contentHash: doc.view.contentHash, newerRevisionAvailable: false });
        expect((await request(controller, `/api/presentations/sessions/${session.id}/view?view=focus`)).status).toBe(400);
    }
});

test('exact document revision and hash are mandatory; unsupported media and missing registered primary are refused', async () => {
    const doc = registerDocument();
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() });
    const attempt = view => request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: source.id, targetId: 'monitor-1', view } });
    expect((await attempt({ ...doc.view, contentHash: '0'.repeat(64) })).data.code).toBe('revision_mismatch');
    expect((await attempt({ ...doc.view, documentId: 'other' })).status).toBe(404);
    expect((await attempt({ kind: 'document', documentId: 'doc-1' })).status).toBe(400);
    const html = registerDocument({ id: 'html', revisionId: 'html-rev', mediaType: 'html', mimeType: 'text/html', bytes: Buffer.from('<script>secret()</script>') });
    expect((await attempt(html.view)).data.code).toBe('unsupported_media');
    const video = registerDocument({ id: 'missing', revisionId: 'missing-rev', mediaType: 'video', mimeType: 'video/mp4', assets: false });
    expect((await attempt(video.view)).data.code).toBe('asset_unavailable');
});

test('document text stays pinned when the current document changes and signals a newer revision', async () => {
    const doc = registerDocument();
    const session = await start(doc.view);
    fs.writeFileSync(doc.file, '# Current replacement');
    rows.documents.get('doc-1').current_revision_id = 'rev-2';
    rows.revisions.set('rev-2', { id: 'rev-2', document_id: 'doc-1', content: '# New content' });
    const snapshot = await request(controller, `/api/presentations/sessions/${session.id}/view`);
    expect(snapshot.data.content).toMatchObject({ revisionId: 'rev-1', contentHash: doc.view.contentHash, content: '# Pinned report\n', newerRevisionAvailable: true });
    expect((await request(controller, `/api/presentations/sessions/${session.id}/asset?revision=rev-2`)).status).toBe(400);
});

test('active focus distinguishes fresh runtime activity from board labels without leaking executor payloads', async () => {
    rows.activity = { executors: { runs: [{ taskId: 't2', executor: 'codex', status: 'active', phase: 'thinking', startedAt: iso(current), updatedAt: iso(current), message: 'PRIVATE_PROGRESS', workspace: '/private/runtime' },
        { taskId: 't3', executor: 'codex', status: 'completed', phase: 'done', startedAt: iso(current), updatedAt: iso(current) }], cliQueue: [], sessions: [] }, cron: [], localLlm: { jobs: [] }, chatSessions: ['PRIVATE_CHAT'] };
    const session = await start({ kind: 'focus', mode: 'active' });
    const snapshot = await request(controller, `/api/presentations/sessions/${session.id}/view`);
    expect(snapshot.data.content.tasks.map(task => task.id)).toEqual(['t1', 't2']);
    expect(snapshot.data.content.activity).toEqual({ available: true, taskIds: ['t2'], snapshotAt: iso(current) });
    expect(JSON.stringify(snapshot.data)).not.toMatch(/PRIVATE_|workspace|executor|thinking/);
    rows.activity = { invalid: true };
    const unavailable = await request(controller, `/api/presentations/sessions/${session.id}/view`);
    expect(unavailable.data.content.activity).toEqual({ available: false, taskIds: [], snapshotAt: null });
    expect(unavailable.data.content.tasks.map(task => task.id)).toEqual(['t1']);
});

test('native confirmation, explicit stop, lease expiry, and hard expiry revoke reads', async () => {
    const session = await start();
    expect((await request(controller, `/api/presentations/sessions/${session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } })).data.state).toBe('active');
    expect((await request(controller, `/api/presentations/sessions/${session.id}`, { method: 'DELETE' })).data.state).toBe('stopped');
    expect((await request(controller, `/api/presentations/sessions/${session.id}/view`)).status).toBe(410);
    expect((await request(controller, `/api/presentations/sessions/${session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } })).status).toBe(410);
    const unrenewed = await start(); current += 45_001;
    expect((await request(controller, `/api/presentations/sessions/${unrenewed.id}/view`)).status).toBe(410);
    expect((await request(controller, `/api/presentations/sessions/${unrenewed.id}`)).data).toMatchObject({ state: 'expired', reason: expect.stringMatching(/controller/i) });
    const bounded = await start();
    for (let i = 0; i < 45; i++) {
        current += 40_000;
        const beat = await request(controller, `/api/presentations/sessions/${bounded.id}/heartbeat`, { method: 'POST', body: { state: 'active' } });
        expect(beat.status).toBe(i === 44 ? 410 : 200);
    }
});

test('pairing is single-use, scoped to the original receiver, and issues no credentials to the controller', async () => {
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'Hotel TV' } });
    expect(pending.status).toBe(201);
    expect(pending.data.code).toMatch(/^[A-Z0-9]{8,}$/);
    expect(Buffer.from(pending.data.pollToken, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken })).data).toEqual({ state: 'pending' });
    expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: 'incorrect' })).status).toBe(401);
    const claimBody = { sourceDevice: source, view: { kind: 'ambient' } };
    const claim = await request(controller, `/api/presentations/pairings/${pending.data.code}/claim`, { method: 'POST', body: claimBody });
    expect(claim.status).toBe(201);
    expect(JSON.stringify(claim.data)).not.toMatch(/token|cookie|jwt/i);
    expect(claim.data.target).toMatchObject({ method: 'paired-browser', name: 'Hotel TV', sourceDeviceId: source.id });
    expect((await request(controller, `/api/presentations/pairings/${pending.data.code}/claim`, { method: 'POST', body: claimBody })).status).toBe(409);
    const poll = await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken });
    expect(poll.data.state).toBe('paired');
    expect(Buffer.from(poll.data.token, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(poll.data.session.id).toBe(claim.data.session.id);
    expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken })).status).toBe(404);
    expect((await request(receiver, '/receiver/view', { token: poll.data.token })).data.content.kind).toBe('ambient');
    expect((await request(controller, '/api/presentations/sessions', { signed: false, token: poll.data.token })).status).toBe(401);
});

test('receiver cannot choose another view or access APIs, mutations, credentials, or arbitrary static files', async () => {
    const paired = await pair();
    expect((await request(receiver, '/receiver/view?token=' + paired.token)).status).toBe(400);
    expect((await request(receiver, '/receiver/view?revision=other', { token: paired.token })).status).toBe(400);
    for (const url of ['/api/tasks', '/api/documents', '/receiver/sessions/other', '/receiver/asset/../../api/tasks', '/server.js']) {
        expect((await request(receiver, url, { token: paired.token })).status).toBe(404);
    }
    expect((await request(receiver, '/receiver/view', { method: 'POST', token: paired.token, body: { kind: 'focus' } })).status).toBe(404);
    expect((await request(receiver, '/receiver/view', { headers: { cookie: 'CF_Authorization=anything', 'cf-access-jwt-assertion': access.token() } })).status).toBe(401);
    expect((await request(receiver, '/receiver/view', { token: paired.token })).headers.get('cache-control')).toBe('no-store');
    const html = await request(receiver, '/presentation/index.html');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(html.headers.get('set-cookie')).toBeNull();
    expect(html.headers.get('access-control-allow-origin')).toBeNull();
});

test('receiver media serves the exact captured primary with byte ranges and stop revokes it', async () => {
    const doc = registerDocument({ mediaType: 'video', mimeType: 'video/mp4', bytes: Buffer.from('0123456789abcdef') });
    const paired = await pair(doc.view);
    fs.writeFileSync(doc.file, 'changed replacement');
    const snapshot = await request(receiver, '/receiver/view', { token: paired.token });
    expect(snapshot.data.content.assetUrl).toBe('/receiver/asset');
    const range = await request(receiver, '/receiver/asset', { token: paired.token, headers: { range: 'bytes=2-5' } });
    expect(range.status).toBe(206); expect(range.data).toBe('2345');
    expect(range.headers.get('content-range')).toBe('bytes 2-5/16');
    expect(range.headers.get('content-type')).toBe('video/mp4');
    expect((await request(receiver, '/receiver/asset', { token: paired.token, headers: { range: 'bytes=99-100' } })).status).toBe(416);
    expect((await request(receiver, '/receiver/asset?asset=other', { token: paired.token })).status).toBe(400);
    await request(controller, `/api/presentations/sessions/${paired.session.id}`, { method: 'DELETE' });
    expect((await request(receiver, '/receiver/asset', { token: paired.token })).status).toBe(401);
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(401);
});

test('pairing codes and receiver capabilities expire, and process restart forgets all authority', async () => {
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' } });
    current += 120_001;
    expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken })).status).toBe(404);
    const paired = await pair(); current += 45_001;
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(401);
    const another = await pair();
    await service.close();
    expect((await request(receiver, '/receiver/view', { token: another.token })).status).toBe(401);
});

test('receiver refuses cross-origin enrollment and bounds enrollment requests', async () => {
    expect((await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' }, headers: { origin: 'https://attacker.test' } })).status).toBe(403);
    for (let i = 0; i < 10; i++) expect((await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' } })).status).toBe(201);
    expect((await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' } })).status).toBe(429);
});

test('receiver listener is opt-in with loopback default and rejects unsafe remote HTTP origin', () => {
    expect(receiverConfiguration({})).toEqual({ enabled: false, port: null, host: '127.0.0.1', origin: null });
    expect(receiverConfiguration({ NEXUS_PRESENTATION_RECEIVER_PORT: '4010' })).toEqual({ enabled: true, port: 4010, host: '127.0.0.1', origin: 'http://127.0.0.1:4010' });
    expect(() => receiverConfiguration({ NEXUS_PRESENTATION_RECEIVER_PORT: '4010', NEXUS_PRESENTATION_RECEIVER_ORIGIN: 'http://public.example' })).toThrow();
    expect(() => receiverConfiguration({ NEXUS_PRESENTATION_RECEIVER_PORT: '0' })).toThrow();
    expect(() => receiverConfiguration({ NEXUS_PRESENTATION_RECEIVER_PORT: '4010', NEXUS_PRESENTATION_RECEIVER_ORIGIN: 'https://public.example/path' })).toThrow();
});

test('every controller mutation and selected read refuses missing, expired, and forged authority', async () => {
    const session = await start();
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' } });
    const matrix = [
        ['PUT', '/inventory', inventory()],
        ['POST', '/sessions', { sourceDeviceId: source.id, targetId: 'monitor-1', view: { kind: 'ambient' } }],
        ['GET', `/sessions/${session.id}`], ['GET', `/sessions/${session.id}/view`], ['GET', `/sessions/${session.id}/asset`],
        ['POST', `/sessions/${session.id}/heartbeat`, { state: 'active' }], ['DELETE', `/sessions/${session.id}`],
        ['POST', `/pairings/${pending.data.code}/claim`, { sourceDevice: source, view: { kind: 'ambient' } }],
    ];
    const expired = access.token({ exp: Math.floor(Date.now() / 1000) - 1 });
    const forged = access.token().split('.').slice(0, 2).join('.') + '.' + crypto.randomBytes(256).toString('base64url');
    for (const token of [null, expired, forged]) {
        for (const [method, url, body] of matrix) {
            expect((await request(controller, '/api/presentations' + url, { method, body, signed: false,
                headers: token ? { 'cf-access-jwt-assertion': token } : {} })).status).toBe(401);
        }
    }
    expect((await request(controller, `/api/presentations/sessions/${session.id}`)).data.state).toBe('starting');
    expect(JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain(expired);
    expect(JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain(forged);
});

test('PDF and image capture keep their exact registered bytes and do not expose filesystem identities', async () => {
    const examples = [
        { id: 'pdf', revisionId: 'pdf-rev', mediaType: 'pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nregistered fixture') },
        { id: 'image', revisionId: 'image-rev', mediaType: 'image', mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64') },
    ];
    for (const example of examples) {
        const doc = registerDocument(example);
        const session = await start(doc.view);
        fs.writeFileSync(doc.file, 'new unrelated bytes');
        const response = await fetchHttp(`${controller.url}/api/presentations/sessions/${session.id}/asset`, { headers: { 'cf-access-jwt-assertion': access.token() } });
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(example.bytes);
        const snapshot = await request(controller, `/api/presentations/sessions/${session.id}/view`);
        expect(snapshot.data.content).toMatchObject({ mediaType: example.mediaType, mimeType: example.mimeType, assetByteLength: example.bytes.length, content: null });
        expect(JSON.stringify(snapshot.data)).not.toContain(workspace);
    }
});

test('corrupt stored media is rejected even when review-media locates an existing blob', async () => {
    const doc = registerDocument({ mediaType: 'video', mimeType: 'video/mp4', bytes: Buffer.from('registered bytes') });
    media.storeBlob(doc.view.contentHash, Buffer.from('tampered bytes!!'));
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() });
    const failed = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: source.id, targetId: 'monitor-1', view: doc.view } });
    expect(failed.status).toBe(409);
    expect(failed.data.code).toBe('revision_mismatch');
    expect(JSON.stringify(failed.data)).not.toContain(workspace);
});

test('two receiver capabilities remain isolated to their selected document revisions', async () => {
    const first = registerDocument({ id: 'a', revisionId: 'a1', bytes: Buffer.from('# A') });
    const second = registerDocument({ id: 'b', revisionId: 'b1', bytes: Buffer.from('# B') });
    const a = await pair(first.view);
    const b = await pair(second.view);
    expect((await request(receiver, '/receiver/view', { token: a.token })).data.content.content).toBe('# A');
    expect((await request(receiver, '/receiver/view', { token: b.token })).data.content.content).toBe('# B');
    expect((await request(receiver, '/receiver/view?session=' + b.session.id, { token: a.token })).status).toBe(400);
    expect((await request(receiver, '/receiver/asset', { token: a.token })).data).toBe('# A');
    await request(controller, `/api/presentations/sessions/${a.session.id}`, { method: 'DELETE' });
    expect((await request(receiver, '/receiver/view', { token: a.token })).status).toBe(401);
    expect((await request(receiver, '/receiver/view', { token: b.token })).data.content.content).toBe('# B');
});

test('inventories and sessions have finite capacity and stopped session capacity is reusable', async () => {
    for (let i = 0; i < 16; i++) {
        const sourceDevice = { ...source, id: `device-${i}` };
        const report = inventory({ sourceDevice, targets: [{ ...inventory().targets[0], sourceDeviceId: sourceDevice.id }] });
        expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: report })).status).toBe(200);
    }
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() })).status).toBe(429);
    const ids = [];
    for (let i = 0; i < 32; i++) {
        const result = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: 'device-0', targetId: 'monitor-1', view: { kind: 'ambient' } } });
        expect(result.status).toBe(201); ids.push(result.data.id);
    }
    const attempt = () => request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: 'device-0', targetId: 'monitor-1', view: { kind: 'ambient' } } });
    expect((await attempt()).status).toBe(429);
    await request(controller, `/api/presentations/sessions/${ids[0]}`, { method: 'DELETE' });
    expect((await attempt()).status).toBe(201);
});

test('receiver pairing attempts are bounded and a disconnected presentation requires a new session', async () => {
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'TV' } });
    for (let i = 0; i < 8; i++) expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: 'incorrect' })).status).toBe(401);
    expect((await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken })).status).toBe(404);
    const session = await start();
    expect((await request(controller, `/api/presentations/sessions/${session.id}/heartbeat`, { method: 'POST', body: { state: 'disconnected' } })).data.state).toBe('disconnected');
    expect((await request(controller, `/api/presentations/sessions/${session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } })).status).toBe(410);
    expect((await request(controller, `/api/presentations/sessions/${session.id}/view`)).status).toBe(410);
});

test('revocation closes an already open receiver media stream', async () => {
    const doc = registerDocument({ mediaType: 'video', mimeType: 'video/mp4', bytes: Buffer.alloc(16 * 1024 * 1024, 65) });
    const paired = await pair(doc.view);
    const response = await new Promise((resolve, reject) => {
        const req = http.get(receiver.url + '/receiver/asset', { headers: { authorization: `Bearer ${paired.token}` } }, res => { res.pause(); resolve(res); });
        req.on('error', reject);
    });
    const completed = new Promise(resolve => { response.on('error', () => resolve('revoked')); response.on('end', () => resolve('complete')); });
    await request(controller, `/api/presentations/sessions/${paired.session.id}`, { method: 'DELETE' });
    response.resume();
    expect(await completed).toBe('revoked');
});

test('an invalid calendar day is refused before a session is created', async () => {
    await request(controller, '/api/presentations/inventory', { method: 'PUT', body: inventory() });
    const response = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: source.id, targetId: 'monitor-1', view: { kind: 'day-plan', date: '2026-02-31' } } });
    expect(response.status).toBe(400);
    expect(response.data.code).toBe('invalid_request');
});

test('Android inventory follows the same provenance contract and focus board results are bounded', async () => {
    const android = { id: 'android-test', name: 'Travel phone', platform: 'android' };
    const report = inventory({ sourceDevice: android, targets: [{ ...inventory().targets[0], id: 'android-display', sourceDeviceId: android.id, method: 'android-presentation' }] });
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: report })).status).toBe(200);
    rows.tasks = Array.from({ length: 105 }, (_, index) => ({ id: `task-${index}`, name: `Task ${index}`, status: 'todo', description: 'PRIVATE_BRIEF' }));
    const session = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: android.id, targetId: 'android-display', view: { kind: 'focus', mode: 'board' } } });
    expect(session.status).toBe(201);
    const view = await request(controller, `/api/presentations/sessions/${session.data.id}/view`);
    expect(view.data.content.tasks).toHaveLength(100);
    expect(view.data.content.truncated).toBe(true);
    expect(JSON.stringify(view.data)).not.toContain('PRIVATE_BRIEF');
});

test('receiver rejects excessive simultaneous media streams for one capability', async () => {
    const doc = registerDocument({ mediaType: 'video', mimeType: 'video/mp4', bytes: Buffer.alloc(16 * 1024 * 1024, 66) });
    const paired = await pair(doc.view);
    const open = () => new Promise((resolve, reject) => {
        const req = http.get(receiver.url + '/receiver/asset', { headers: { authorization: `Bearer ${paired.token}` } }, res => {
            res.on('error', () => {}); res.pause(); resolve(res);
        });
        req.on('error', reject);
    });
    const streams = [];
    try {
        for (let i = 0; i < 4; i++) streams.push(await open());
        const excess = await open();
        streams.push(excess);
        expect(excess.statusCode).toBe(429);
        expect(excess.headers['content-type']).toMatch(/application\/json/);
    } finally {
        for (const stream of streams) stream.destroy();
    }
});

test('controller heartbeat cannot claim a paired browser is active before the TV redeems its token', async () => {
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'Waiting TV' } });
    const claim = await request(controller, `/api/presentations/pairings/${pending.data.code}/claim`, { method: 'POST', body: { sourceDevice: source, view: { kind: 'ambient' } } });
    const session = claim.data.session;
    expect(session.state).toBe('starting');
    const beat = await request(controller, `/api/presentations/sessions/${session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } });
    expect(beat.data.state).toBe('starting');
    const poll = await request(receiver, `/receiver/pairings/${pending.data.code}`, { token: pending.data.pollToken });
    expect(poll.data.session.state).toBe('active');
});

test('a closed TV disconnects after 45 seconds even when the controller continues renewing', async () => {
    const paired = await pair();
    current += 40_000;
    expect((await request(controller, `/api/presentations/sessions/${paired.session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } })).status).toBe(200);
    current += 5_001;
    const session = await request(controller, `/api/presentations/sessions/${paired.session.id}`);
    expect(session.data).toMatchObject({ state: 'disconnected', reason: expect.stringMatching(/receiver/i) });
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(401);
});

test('receiver reads renew its own liveness without renewing controller authority', async () => {
    const paired = await pair();
    current += 30_000;
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(200);
    expect((await request(controller, `/api/presentations/sessions/${paired.session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } })).status).toBe(200);
    current += 30_000;
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(200);
    current += 15_001;
    expect((await request(receiver, '/receiver/view', { token: paired.token })).status).toBe(401);
    expect((await request(controller, `/api/presentations/sessions/${paired.session.id}`)).data.reason).toMatch(/controller/i);
});

test('an unredeemed claimed receiver expires with its pairing even while controller heartbeats continue', async () => {
    const pending = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'Waiting TV' } });
    const claim = await request(controller, `/api/presentations/pairings/${pending.data.code}/claim`, { method: 'POST', body: { sourceDevice: source, view: { kind: 'ambient' } } });
    for (let i = 0; i < 3; i++) {
        current += 40_000;
        await request(controller, `/api/presentations/sessions/${claim.data.session.id}/heartbeat`, { method: 'POST', body: { state: 'active' } });
    }
    expect((await request(controller, `/api/presentations/sessions/${claim.data.session.id}`)).data.state).toBe('expired');
});

test('only the explicit Cast entry permits the vendor SDK and it never exposes operator routes', async () => {
    const cast = await request(receiver, '/presentation/cast.html');
    expect(cast.status).toBe(200);
    expect(cast.headers.get('content-security-policy')).toContain('https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/');
    expect(cast.headers.get('content-security-policy')).toContain('ws://localhost:8008/v2/ipc');
    const ordinary = await request(receiver, '/presentation/index.html');
    expect(ordinary.headers.get('content-security-policy')).not.toContain('https://www.gstatic.com');
    expect(ordinary.headers.get('content-security-policy')).not.toContain('ws://localhost');
    expect((await request(receiver, '/api/presentations/config')).status).toBe(404);
    expect((await request(receiver, '/presentation/other.html')).status).toBe(404);
    expect((await request(receiver, '/presentation/icon.png')).status).toBe(200);
});

test('Android can present all shared families and pair a receiver without transferring operator authority', async () => {
    const phone = { id: 'android:phone-1', name: 'Android phone', platform: 'android' };
    const report = inventory({ sourceDevice: phone });
    report.targets = report.targets.map(t => ({ ...t, sourceDeviceId: phone.id, method: 'android-presentation' }));
    expect((await request(controller, '/api/presentations/inventory', { method: 'PUT', body: report })).status).toBe(200);
    const document = registerDocument();
    for (const view of [{ kind: 'ambient' }, { kind: 'focus', mode: 'active' }, { kind: 'focus', mode: 'board' }, { kind: 'day-plan', date: '2026-10-20' }, document.view]) {
        const created = await request(controller, '/api/presentations/sessions', { method: 'POST', body: { sourceDeviceId: phone.id, targetId: 'monitor-1', view } });
        expect(created.status).toBe(201);
        expect((await request(controller, `/api/presentations/sessions/${created.data.id}/view`)).data.content.kind).toBe(view.kind);
        expect((await request(controller, `/api/presentations/sessions/${created.data.id}`, { method: 'DELETE' })).data.state).toBe('stopped');
    }
    const enrolled = await request(receiver, '/receiver/pairings', { method: 'POST', body: { name: 'Cast display' } });
    const claimed = await request(controller, `/api/presentations/pairings/${enrolled.data.code}/claim`, { method: 'POST', body: { sourceDevice: phone, view: document.view } });
    expect(claimed.status).toBe(201);
    const poll = await request(receiver, `/receiver/pairings/${enrolled.data.code}`, { token: enrolled.data.pollToken });
    expect((await request(receiver, '/receiver/view', { token: poll.data.token })).data.content.revisionId).toBe(document.view.revisionId);
    expect((await request(controller, '/api/presentations/sessions', { signed: false, token: poll.data.token })).status).toBe(401);
    await request(controller, `/api/presentations/sessions/${claimed.data.session.id}`, { method: 'DELETE' });
    expect((await request(receiver, '/receiver/view', { token: poll.data.token })).status).toBe(401);
});
