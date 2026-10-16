/**
 * Review media and design packages (contract:
 * docs/contracts/review-media-and-design-packages.md).
 *
 * Isolated NEXUS_DB_PATH, a temporary project root and a temporary blob
 * store. Images are generated in the test (valid 1x1 PNGs), so nothing here
 * touches a real project, Praxis or the live database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { createHash } = require('crypto');
const express = require('express');
const access = require('./helpers/operator-access');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_A = '22222222-2222-4222-8222-22222222222a';

let db;
let base;
let server;
let workspace;
let projectRoot;
let restoreAccess;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** A valid PNG of the given size (RGB, single colour), different bytes per colour. */
function png(width, height, rgb = [200, 40, 40]) {
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc32 = buf => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
        return Buffer.concat([len, typed, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const all = { ...headers };
    if (body !== undefined) all['content-type'] = 'application/json';
    if (user) all['x-test-user'] = user;
    const response = await nativeFetch(base + url, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, json: payload, headers: response.headers };
}

const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };

function write(relative, content) {
    const file = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function declared(file, extra = {}, deliverable = {}) {
    return {
        path: file, title: extra.title || 'Deliverable', project_id: PROJECT_ID, task_id: TASK_A, kind: extra.kind || 'document',
        deliverable: { purpose: 'Review it', requires_review: true, intended_action: 'none', ...deliverable },
        ...(extra.expected_content_hash ? { expected_content_hash: extra.expected_content_hash } : {}),
    };
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(workspace, 'blobs');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Joey');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Joey', path: projectRoot });
    await db.createTask({ id: TASK_A, project_id: PROJECT_ID, name: 'Succession redesign', status: 'in_progress' });
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false, limit: '10mb' }));
    app.use('/api/documents', (req, _res, next) => {
        const user = req.headers['x-test-user'];
        if (user) req.user = { id: String(user), role: 'admin', is_service: false };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery: { deliver: jest.fn(async () => null) } }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    restoreAccess();
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_REVIEW_BLOB_DIR;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('the media model classifies paths, refuses unsupported types and reports editability', () => {
    const media = require('../services/review-media');
    expect(media.classifyPath('/x/a.md')).toBe('markdown');
    expect(media.classifyPath('/x/a.PNG')).toBe('image');
    expect(media.classifyPath('/x/a.mov')).toBe('video');
    expect(media.classifyPath('/x/a.design.json')).toBe('design');
    expect(media.classifyPath('/x/a.json')).toBe('json');
    expect(media.classifyPath('/x/.md')).toBeNull();
    expect(media.classifyPath('/x/a.env')).toBeNull();
    expect(media.classifyPath('/x/a.exe')).toBeNull();
    expect(media.isEditableMedia('markdown')).toBe(true);
    expect(media.isEditableMedia('image')).toBe(false);
    expect(media.mimeFor('/x/a.mp4')).toBe('video/mp4');
    expect(media.imageDimensions(png(3, 2))).toEqual({ width: 3, height: 2 });
});

test('an image registers as a binary revision, is copied into the blob store, streams with ranges and survives the file changing', async () => {
    const bytes = png(4, 4);
    const file = write('docs/qa/screen.png', bytes);
    const registered = await api('POST', '/api/documents', declared(file, { title: 'Screen S1', kind: 'image', expected_content_hash: sha(bytes) }));
    expect(registered.status).toBe(201);
    const { document, revision, receipt } = registered.json;
    expect(document.media_type).toBe('image');
    expect(revision).toMatchObject({ media_type: 'image', mime_type: 'image/png', line_count: 0, byte_length: bytes.length, content_hash: sha(bytes), width: 4, height: 4, asset_count: 1 });
    expect(receipt).toMatchObject({ media_type: 'image', asset_count: 1, preview_asset_key: 'primary', readiness_path: `/api/documents/${document.id}/readiness?revision=${revision.id}` });
    expect(fs.existsSync(path.join(workspace, 'blobs', sha(bytes).slice(0, 2), sha(bytes)))).toBe(true);

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json).toMatchObject({ media_type: 'image', editable: false, content: '', readiness: { ready: true, required_total: 1, required_ok: 1 } });
    expect(read.json.assets).toEqual([expect.objectContaining({ asset_key: 'primary', role: 'primary', media_type: 'image', content_hash: sha(bytes) })]);

    const asset = await api('GET', `/api/documents/${document.id}/assets/primary?revision=${revision.id}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(asset.headers.get('x-asset-hash')).toBe(sha(bytes));
    expect(asset.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.compare(asset.json, bytes)).toBe(0);
    const range = await api('GET', `/api/documents/${document.id}/assets/primary?revision=${revision.id}`, undefined, { headers: { range: 'bytes=0-7' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 0-7/${bytes.length}`);
    expect(Buffer.compare(range.json, bytes.subarray(0, 8))).toBe(0);
    const raw = await api('GET', `/api/documents/${document.id}/raw?revision=${revision.id}`);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(Buffer.compare(raw.json, bytes)).toBe(0);
    expect((await api('GET', `/api/documents/${document.id}/assets/nope?revision=${revision.id}`)).status).toBe(404);
    expect((await api('GET', `/api/documents/${document.id}/assets/..%2F..%2Fetc?revision=${revision.id}`)).status).toBe(400);

    // The producer replaces the file: a new revision, the old bytes still served from the blob store.
    const next = png(4, 4, [10, 200, 10]);
    fs.writeFileSync(file, next);
    const reread = await api('GET', `/api/documents/${document.id}`);
    expect(reread.json.revision.content_hash).toBe(sha(next));
    expect(reread.json.revision.id).not.toBe(revision.id);
    const old = await api('GET', `/api/documents/${document.id}/assets/primary?revision=${revision.id}`);
    expect(old.status).toBe(200);
    expect(Buffer.compare(old.json, bytes)).toBe(0);
    const edit = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: reread.json.revision.id, content: 'x' }, operator);
    expect(edit).toMatchObject({ status: 409, json: { code: 'not_editable' } });
});

function designFixture({ directions = true, before = true, name = 'hwc09' } = {}) {
    const s1 = write('docs/design/export/s1-1a-light.png', png(2, 2, [1, 2, 3]));
    write('docs/design/export/s1-1b-light.png', png(2, 2, [4, 5, 6]));
    write('docs/design/export/s2-1a-dark.png', png(2, 3, [7, 8, 9]));
    if (before) write('docs/design/before/s1.png', png(2, 2, [90, 90, 90]));
    write('docs/design/export/tokens.json', JSON.stringify({ color: { ink: '#111' } }));
    write('docs/design/export/screens-light.dc.html', '<!doctype html><title>proto</title><div id="s1">S1</div>');
    write('docs/design/design-session.md', '# Session\n\nRecorded.\n');
    const manifest = {
        format: 'nexus-design-package/1',
        title: 'Succession redesign (HWC09)',
        summary: 'Three statement directions.',
        ...(directions ? { directions: [
            { id: '1a', title: 'Editorial hairline', recommended: true },
            { id: '1b', title: 'Ink masthead' },
        ] } : {}),
        screens: [
            { id: 'S1-1a-light', title: 'Statement', ...(directions ? { direction: '1a' } : {}), appearance: 'light', viewport: 'iphone-15-pro', file: 'export/s1-1a-light.png', ...(before ? { before: 'before/s1.png' } : {}) },
            { id: 'S1-1b-light', title: 'Statement', ...(directions ? { direction: '1b' } : {}), appearance: 'light', file: 'export/s1-1b-light.png' },
            { id: 'S2-1a-dark', title: 'Rates', ...(directions ? { direction: '1a' } : {}), appearance: 'dark', file: 'export/s2-1a-dark.png', notes: 'Oxblood debits.' },
        ],
        tokens: 'export/tokens.json',
        previews: [{ id: 'proto-light', title: 'Screens (light)', file: 'export/screens-light.dc.html', viewport: 'iphone-15-pro' }],
        evidence: [{ id: 'session', label: 'Claude Design session record', file: 'design-session.md' }],
        source: { provider: 'claude-design', project_id: 'efc6cadb', stage: 'review_direction' },
    };
    const file = write(`docs/design/${name}.design.json`, JSON.stringify(manifest, null, 2));
    return { file, manifest, s1 };
}

test('a design package registers its members as one revision with the contract package hash, serves them by asset key and reports readiness', async () => {
    const media = require('../services/review-media');
    const { file } = designFixture();
    const manifestBytes = fs.readFileSync(file);
    const members = [
        ['screen:S1-1a-light', 'docs/design/export/s1-1a-light.png'], ['before:S1-1a-light', 'docs/design/before/s1.png'],
        ['screen:S1-1b-light', 'docs/design/export/s1-1b-light.png'], ['screen:S2-1a-dark', 'docs/design/export/s2-1a-dark.png'],
        ['tokens', 'docs/design/export/tokens.json'], ['preview:proto-light', 'docs/design/export/screens-light.dc.html'],
        ['evidence:session', 'docs/design/design-session.md'],
    ].map(([asset_key, rel]) => ({ asset_key, content_hash: sha(fs.readFileSync(path.join(projectRoot, rel))) }));
    const expected = media.packageHash(sha(manifestBytes), members);
    // The algorithm, spelled out (contract §2.3), so a producer can reproduce it.
    const lines = [...members].sort((a, b) => (a.asset_key < b.asset_key ? -1 : 1)).map(m => `${m.asset_key}\t${m.content_hash}\n`).join('');
    expect(expected).toBe(sha(`${sha(manifestBytes)}\n${lines}`));

    const wrongHash = await api('POST', '/api/documents', declared(file, { title: 'HWC09 designs', kind: 'design', expected_content_hash: sha(manifestBytes) }));
    expect(wrongHash).toMatchObject({ status: 409, json: { code: 'content_mismatch', content_hash: expected } });
    const registered = await api('POST', '/api/documents', declared(file, { title: 'HWC09 designs', kind: 'design', expected_content_hash: expected }));
    expect(registered.status).toBe(201);
    const { document, revision, receipt } = registered.json;
    expect(revision).toMatchObject({ media_type: 'design', content_hash: expected, asset_count: 8 });
    expect(receipt).toMatchObject({ media_type: 'design', asset_count: 8, preview_asset_key: 'screen:S1-1a-light' });

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json.manifest.directions.map(d => d.id)).toEqual(['1a', '1b']);
    expect(read.json.assets.map(a => a.asset_key)).toEqual(['primary', 'screen:S1-1a-light', 'before:S1-1a-light', 'screen:S1-1b-light', 'screen:S2-1a-dark', 'tokens', 'preview:proto-light', 'evidence:session']);
    expect(read.json.assets.find(a => a.asset_key === 'screen:S2-1a-dark')).toMatchObject({ role: 'screen', direction: '1a', appearance: 'dark', width: 2, height: 3, label: 'Rates' });
    expect(read.json.assets.find(a => a.asset_key === 'screen:S1-1a-light').before_asset_key).toBe('before:S1-1a-light');
    expect(read.json.readiness).toMatchObject({ ready: true, required_total: 4, required_ok: 4 });
    expect(read.json.editable).toBe(true);

    const screen = await api('GET', `/api/documents/${document.id}/assets/screen:S2-1a-dark?revision=${revision.id}`);
    expect(screen.status).toBe(200);
    expect(screen.headers.get('content-type')).toBe('image/png');
    const proto = await api('GET', `/api/documents/${document.id}/assets/preview:proto-light?revision=${revision.id}`);
    expect(proto.headers.get('content-type')).toBe('text/html');
    expect(proto.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    const evidence = await api('GET', `/api/documents/${document.id}/assets/evidence:session?revision=${revision.id}`);
    expect(evidence.json.toString()).toBe('# Session\n\nRecorded.\n');
    const primary = await api('GET', `/api/documents/${document.id}/raw?revision=${revision.id}`);
    expect(primary.headers.get('content-type')).toMatch(/^application\/json/);
    expect(primary.json.format).toBe('nexus-design-package/1');

    // A screen deleted from disk: readiness says so, but the registered bytes still serve from the blob store.
    fs.unlinkSync(path.join(projectRoot, 'docs/design/export/s1-1b-light.png'));
    const readiness = await api('GET', `/api/documents/${document.id}/readiness?revision=${revision.id}`);
    expect(readiness.json).toMatchObject({ ready: true, required_total: 4, required_ok: 4 });
    expect(readiness.json.checks.find(c => c.asset_key === 'screen:S1-1b-light')).toMatchObject({ ok: true, status: 'servable', source: 'blob' });
    const served = await api('GET', `/api/documents/${document.id}/assets/screen:S1-1b-light?revision=${revision.id}`);
    expect(served.status).toBe(200);
    // Now the document itself: the manifest is unchanged but a member is gone, so a fresh capture cannot resolve the package.
    const reread = await api('GET', `/api/documents/${document.id}`);
    expect(reread.json.file_state).toBe('member_missing');
    expect(reread.json.revision.id).toBe(revision.id);
});

test('approving a multi-direction design package requires selecting a direction, which the decision and history carry', async () => {
    const { file } = designFixture();
    const registered = await api('POST', '/api/documents', declared(file, { title: 'HWC09 designs', kind: 'design' }));
    const { document, revision } = registered.json;
    const noSelection = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1' }, operator);
    expect(noSelection).toMatchObject({ status: 400, json: { code: 'selection_required', directions: ['1a', '1b'] } });
    const unknown = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1', selection: { direction: '9z' } }, operator);
    expect(unknown).toMatchObject({ status: 400, json: { code: 'selection_required' } });
    const changes = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'request_changes', revision_id: revision.id, client_decision_id: 'd-0', note: 'S2 needs the hairline' }, operator);
    expect(changes.status).toBe(201);
    const selected = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1', selection: { direction: '1a' } }, operator);
    expect(selected.status).toBe(201);
    expect(selected.json.decision.selection).toEqual({ direction: '1a' });
    expect(selected.json.review_status).toBe('approved');
    const replay = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1', selection: { direction: '1a' } }, operator);
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true } });
    const reused = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1', selection: { direction: '1b' } }, operator);
    expect(reused).toMatchObject({ status: 409, json: { code: 'idempotency_key_reused' } });
    const history = await api('GET', `/api/documents/${document.id}/history`);
    expect(history.json.decisions.map(d => [d.decision, d.selection])).toEqual([['request_changes', null], ['approve', { direction: '1a' }]]);
    const check = await api('GET', `/api/documents/${document.id}/decisions/${selected.json.decision.id}`);
    expect(check.json.decision.selection).toEqual({ direction: '1a' });

    // A single-direction package needs no selection.
    const single = designFixture({ directions: false, name: 'final' });
    const plain = await api('POST', '/api/documents', { ...declared(single.file, { title: 'Final design', kind: 'design' }), deliverable: { key: 'final', purpose: 'Final', requires_review: true, intended_action: 'implement' } });
    expect(plain.status).toBe(201);
    const approved = await api('POST', `/api/documents/${plain.json.document.id}/decisions`, { decision: 'approve', revision_id: plain.json.revision.id, client_decision_id: 'd-2' }, operator);
    expect([approved.status, approved.json]).toEqual([201, expect.anything()]);
    expect(approved.json.decision.selection).toBeNull();
});

test('media comments anchor to assets with verified coordinates, thread as replies, resolve, and reach the feedback payload with their labels', async () => {
    const { file } = designFixture();
    const { document, revision } = (await api('POST', '/api/documents', declared(file, { title: 'HWC09 designs', kind: 'design' }))).json;
    const review = (await api('POST', `/api/documents/${document.id}/reviews`, {})).json.review;
    expect(review.revision_id).toBe(revision.id);
    const comments = `/api/documents/reviews/${review.id}/comments`;

    const badAsset = await api('POST', comments, { client_id: 'm-0', kind: 'screen', body: 'x', anchor: { asset_key: 'screen:nope' } });
    expect(badAsset).toMatchObject({ status: 409, json: { code: 'anchor_mismatch' } });
    const badRegion = await api('POST', comments, { client_id: 'm-0', kind: 'screen', body: 'x', anchor: { asset_key: 'screen:S1-1a-light', region: { x: 0.5, y: 0.5, w: 0, h: 0.2 } } });
    expect(badRegion).toMatchObject({ status: 400, json: { code: 'invalid_anchor' } });
    const wrongKind = await api('POST', comments, { client_id: 'm-0', kind: 'time', body: 'x', anchor: { asset_key: 'screen:S1-1a-light', t_start: 3 } });
    expect(wrongKind).toMatchObject({ status: 400, json: { code: 'invalid_anchor' } });
    const noPassage = await api('POST', comments, { client_id: 'm-0', kind: 'passage', body: 'x', start_line: 1, end_line: 1, quote: 'not the manifest' });
    expect(noPassage.status).toBe(409);
    // The manifest is text, so a passage comment on its real first line is legitimate.
    expect((await api('POST', comments, { client_id: 'm-00', kind: 'passage', body: 'x', start_line: 1, end_line: 1, quote: '{' })).status).toBe(201);

    const screen = await api('POST', comments, { client_id: 'm-1', kind: 'screen', body: 'Hairline too heavy', anchor: { asset_key: 'screen:S1-1a-light', region: { x: 0.12, y: 0.4, w: 0.5, h: 0.1 } } });
    expect(screen.status).toBe(201);
    expect(screen.json.comment).toMatchObject({ kind: 'screen', target_label: 'Statement · 1a · light at (12%, 40%) 50×10%', anchor: { state: 'intact', current_asset_key: 'screen:S1-1a-light' }, parent_id: null, resolved: false });
    expect(screen.json.comment.anchor_target).toMatchObject({ asset_key: "screen:S1-1a-light", region: { x: 0.12, y: 0.4, w: 0.5, h: 0.1 } });
    const point = await api('POST', comments, { client_id: 'm-2', kind: 'point', body: 'Tap target', anchor: { asset_key: 'preview:proto-light', x: 0.9, y: 0.05, viewport: 'iphone-15-pro' } });
    expect(point.status).toBe(201);
    expect(point.json.comment.target_label).toBe('Screens (light) at (90%, 5%) on iphone-15-pro');
    const reply = await api('POST', comments, { client_id: 'm-3', kind: 'document', body: 'Actually keep it', parent_id: screen.json.comment.id });
    expect(reply.status).toBe(201);
    expect(reply.json.comment.parent_id).toBe(screen.json.comment.id);
    const nested = await api('POST', comments, { client_id: 'm-4', kind: 'document', body: 'deeper', parent_id: reply.json.comment.id });
    expect(nested).toMatchObject({ status: 400, json: { code: 'invalid_parent' } });
    const resolved = await api('PATCH', `${comments}/${point.json.comment.id}`, { resolved: true });
    expect(resolved.json.comment.resolved).toBe(true);
    const replay = await api('POST', comments, { client_id: 'm-1', kind: 'screen', body: 'Hairline too heavy', anchor: { asset_key: 'screen:S1-1a-light', region: { x: 0.12, y: 0.4, w: 0.5, h: 0.1 } } });
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true } });

    const selected = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1', selection: { direction: '1a' } }, operator);
    expect(selected.status).toBe(201);
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Go with 1a.' });
    expect(finished.status).toBe(202);
    const submission = db.documentReviews.getSubmission(finished.json.submission.id);
    expect(submission.payload).toMatchObject({ media_type: 'design', selected_direction: '1a' });
    expect(submission.payload.comments.find(c => c.kind === 'screen')).toMatchObject({ target_label: 'Statement · 1a · light at (12%, 40%) 50×10%', anchor_target: { asset_key: 'screen:S1-1a-light' } });
    expect(submission.message_text).toContain('Selected direction: 1a');
    expect(submission.message_text).toContain('**Media comments (2)**');
    expect(submission.message_text).toContain('[Statement · 1a · light at (12%, 40%) 50×10%] Hairline too heavy');
    expect(submission.message_text).toContain('↳ Robert (reply): Actually keep it');
    expect(submission.message_text).toContain('[Screens (light) at (90%, 5%) on iphone-15-pro] [resolved] Tap target');

    // Deleting a root removes its replies with it.
    const review2 = (await api('POST', `/api/documents/${document.id}/reviews`, {})).json.review;
    const root = (await api('POST', `/api/documents/reviews/${review2.id}/comments`, { client_id: 'r-1', kind: 'document', body: 'root' })).json.comment;
    await api('POST', `/api/documents/reviews/${review2.id}/comments`, { client_id: 'r-2', kind: 'document', body: 'child', parent_id: root.id });
    await api('DELETE', `/api/documents/reviews/${review2.id}/comments/${root.id}`);
    expect((await api('GET', `/api/documents/reviews/${review2.id}`)).json.review.comments).toEqual([]);
});

test('a reviewer edit writes the file atomically, records a nexus_edit revision pinned to the one edited, and refuses stale or unauthorized edits', async () => {
    const file = write('docs/plan.md', '# Plan\n\nFirst draft.\n');
    const { document, revision } = (await api('POST', '/api/documents', declared(file, { title: 'Plan', kind: 'plan' }))).json;
    expect((await api('GET', `/api/documents/${document.id}`)).json.editable).toBe(true);

    const unauthorized = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: revision.id, content: '# Plan\n\nEdited.\n' });
    expect(unauthorized.status).toBeGreaterThanOrEqual(400);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Plan\n\nFirst draft.\n');
    const missingBase = await api('PUT', `/api/documents/${document.id}/content`, { content: 'x' }, operator);
    expect(missingBase).toMatchObject({ status: 400, json: { code: 'invalid_edit' } });

    const edited = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: revision.id, content: '# Plan\n\nEdited by Robert.\n', client_edit_id: 'e-1', summary: 'Tightened the intro' }, operator);
    expect(edited.status).toBe(201);
    expect(edited.json.revision).toMatchObject({ source: 'nexus_edit', edited_by: 'local_user', media_type: 'markdown' });
    expect(edited.json.revision.id).not.toBe(revision.id);
    expect(edited.json.edit).toMatchObject({ base_revision_id: revision.id, result_revision_id: edited.json.revision.id, summary: 'Tightened the intro', authority: 'operator_credential' });
    expect(fs.readFileSync(file, 'utf8')).toBe('# Plan\n\nEdited by Robert.\n');
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp'))).toEqual([]);
    const replay = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: revision.id, content: 'ignored on replay', client_edit_id: 'e-1' }, operator);
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true } });
    expect(replay.json.revision.id).toBe(edited.json.revision.id);

    const stale = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: revision.id, content: '# Plan\n\nConflicting.\n', client_edit_id: 'e-2' }, operator);
    expect(stale).toMatchObject({ status: 409, json: { code: 'stale_revision' } });
    expect(stale.json.current_revision.id).toBe(edited.json.revision.id);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Plan\n\nEdited by Robert.\n');

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json.revision.id).toBe(edited.json.revision.id);
    expect(read.json.content).toBe('# Plan\n\nEdited by Robert.\n');
    const history = await api('GET', `/api/documents/${document.id}/history`);
    expect(history.json.edits).toHaveLength(1);
    expect(history.json.revisions.map(r => r.source)).toEqual(['capture', 'nexus_edit']);
    const unchanged = await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: edited.json.revision.id, content: '# Plan\n\nEdited by Robert.\n' }, operator);
    expect(unchanged).toMatchObject({ status: 200, json: { unchanged: true } });

    // A decision on the edited revision does not approve the file as it was before.
    const approved = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, client_decision_id: 'd-1' }, operator);
    expect(approved).toMatchObject({ status: 409, json: { code: 'stale_revision' } });

    // An invalid design manifest is refused before anything is written.
    const { file: manifestFile } = designFixture();
    const pkg = (await api('POST', '/api/documents', declared(manifestFile, { title: 'HWC09 designs', kind: 'design' }))).json;
    const before = fs.readFileSync(manifestFile, 'utf8');
    const broken = await api('PUT', `/api/documents/${pkg.document.id}/content`, { base_revision_id: pkg.revision.id, content: JSON.stringify({ format: 'nexus-design-package/1', title: 'x', screens: [] }) }, operator);
    expect(broken).toMatchObject({ status: 400, json: { code: 'invalid_manifest' } });
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe(before);
    const manifest = JSON.parse(before);
    manifest.screens[2].notes = 'Oxblood debits, hairline rules.';
    const ok = await api('PUT', `/api/documents/${pkg.document.id}/content`, { base_revision_id: pkg.revision.id, content: JSON.stringify(manifest, null, 2) }, operator);
    expect(ok.status).toBe(201);
    expect(ok.json.revision.media_type).toBe('design');
    expect(ok.json.assets.find(a => a.asset_key === 'screen:S2-1a-dark')).toBeTruthy();
});

test('design manifests that break the contract are refused with the rule they broke', async () => {
    const cases = [
        [{ title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.png' }] }, /format/],
        [{ format: 'nexus-design-package/1', screens: [{ id: 'a', title: 'A', file: 'a.png' }] }, /title/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [] }, /at least one screen/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a b', title: 'A', file: 'a.png' }] }, /id matching/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: '../a.png' }] }, /relative path inside/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.mp4' }] }, /image or SVG/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.png', direction: 'z' }] }, /unknown direction/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.png' }, { id: 'a', title: 'B', file: 'b.png' }] }, /Duplicate screen/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.png' }], tokens: 'tokens.yaml' }, /tokens must be a .json/],
        [{ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'a.png' }], evidence: [{ id: 'e', label: 'E', file: 'clip.mp4' }] }, /text media type or a PDF/],
    ];
    const media = require('../services/review-media');
    for (const [manifest, rule] of cases) {
        const result = media.validateDesignManifest(manifest);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(rule);
    }
    // Members that escape the root refuse the whole registration.
    const outside = path.join(workspace, 'outside.png');
    fs.writeFileSync(outside, png(1, 1));
    fs.mkdirSync(path.join(projectRoot, 'docs', 'esc'), { recursive: true });
    fs.symlinkSync(outside, path.join(projectRoot, 'docs', 'esc', 'link.png'));
    const file = write('docs/esc/pkg.design.json', JSON.stringify({ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'link.png' }] }));
    const escaped = await api('POST', '/api/documents', declared(file, { title: 'Escape', kind: 'design' }));
    expect(escaped).toMatchObject({ status: 403, json: { code: 'symlink_escape' } });
    const missing = write('docs/esc/pkg2.design.json', JSON.stringify({ format: 'nexus-design-package/1', title: 'x', screens: [{ id: 'a', title: 'A', file: 'gone.png' }] }));
    expect(await api('POST', '/api/documents', declared(missing, { title: 'Missing', kind: 'design' }))).toMatchObject({ status: 404, json: { code: 'member_missing' } });
});

test('the queue lists media documents with their type and preview asset, and filters by kind', async () => {
    const image = write('docs/shot.png', png(2, 2));
    const md = write('docs/notes.md', '# Notes\n');
    await api('POST', '/api/documents', declared(image, { title: 'Shot', kind: 'image' }));
    await api('POST', '/api/documents', declared(md, { title: 'Notes', kind: 'report' }));
    const list = await api('GET', '/api/documents?status=all');
    const byTitle = Object.fromEntries(list.json.documents.map(d => [d.title, d]));
    expect(byTitle.Shot).toMatchObject({ media_type: 'image', preview_asset_key: 'primary', asset_count: 1, editable: false });
    expect(byTitle.Notes).toMatchObject({ media_type: 'markdown', preview_asset_key: null, editable: true });
    const images = await api('GET', '/api/documents?status=all&kind=image');
    expect(images.json.documents.map(d => d.title)).toEqual(['Shot']);
});
