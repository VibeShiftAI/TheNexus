/**
 * Moving a document's registration from a landed run's worktree to the
 * checkout it landed in (task ec3e1d0c; contract
 * docs/contracts/document-review-deliverables.md §14).
 *
 * Isolated NEXUS_DB_PATH and a temporary Git repository with a real linked
 * worktree (the shape Praxis gives every run). Delivery is a stub and the
 * decision authority is a synthetic operator: nothing here reaches the live
 * database, Praxis, Cloudflare or a mail transport.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');

const nativeFetch = global.fetch;
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_A = '22222222-2222-4222-8222-22222222222a';
const TASK_B = '22222222-2222-4222-8222-22222222222b';

let db;
let base;
let server;
let workspace;
let projectRoot;
let worktree;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// No line-ending conversion: the landed bytes must be the bytes the run wrote, whatever the global Git config says.
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { stdio: 'pipe' }).toString();

async function api(method, url, body, headers = {}) {
    const response = await nativeFetch(base + url, {
        method, headers: { 'content-type': 'application/json', 'x-test-user': 'local_user', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

function write(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function declared(file, { key, taskId = TASK_A, requiresReview = true } = {}) {
    return {
        path: file, title: path.basename(file), project_id: PROJECT_ID, task_id: taskId, kind: 'report',
        deliverable: { ...(key ? { key } : {}), purpose: 'Decide whether the report is ready', requires_review: requiresReview, intended_action: requiresReview ? 'implement' : 'none' },
    };
}

/** Commit everything in the run worktree and fast-forward the project checkout to it: the landing, without Praxis. */
function land(runWorktree = worktree) {
    git(runWorktree, 'add', '-A');
    git(runWorktree, 'commit', '-q', '-m', 'run work');
    const branch = git(runWorktree, 'symbolic-ref', '--short', 'HEAD').trim();
    git(projectRoot, 'merge', '-q', '--ff-only', branch);
}

const relocate = (body = {}) => api('POST', '/api/documents/relocations', { from_root: worktree, to_root: projectRoot, task_id: TASK_A, ...body });
const count = (sql, ...params) => db.raw.prepare(sql).get(...params).n;

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-relocations-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(workspace, 'review-blobs');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    projectRoot = path.join(workspace, 'Praxis');
    fs.mkdirSync(projectRoot, { recursive: true });
    git(projectRoot, 'init', '-q', '-b', 'main');
    write(projectRoot, 'README.md', '# Project\n');
    git(projectRoot, 'add', '-A');
    git(projectRoot, 'commit', '-q', '-m', 'fixture');
    worktree = path.join(workspace, '.praxis-worktrees', 'task-a', 'Praxis');
    git(projectRoot, 'worktree', 'add', '-q', '-b', 'praxis/run/task-a', worktree);
    db = require('../../db');
    db.raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    await db.upsertProject({ id: PROJECT_ID, name: 'Praxis', path: projectRoot });
    await db.createTask({ id: TASK_A, project_id: PROJECT_ID, name: 'Write the report', status: 'in_progress' });
    await db.createTask({ id: TASK_B, project_id: PROJECT_ID, name: 'Revise the report', status: 'in_progress' });
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        if (req.headers['x-test-user']) req.user = { id: String(req.headers['x-test-user']), role: 'admin', is_service: false };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({
        db, delivery: { deliver: jest.fn(async () => null) },
        authorizeDecision: async () => ({ ok: true, via: 'operator_bearer', actor: { id: 'synthetic-operator', authority: 'operator_credential' } }),
    }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    db.raw.close();
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_REVIEW_BLOB_DIR;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('a landed document moves to the landed file and stays decidable after the worktree is removed, keeping id, revision and comments', async () => {
    const file = write(worktree, 'docs/reports/launch.md', '# Launch\r\n\r\nReady to ship.\r\n');
    const registered = await api('POST', '/api/documents', declared(file, { key: 'launch-report' }));
    expect(registered.status).toBe(201);
    const { document, revision } = registered.json;
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'document', body: 'Reads well.' })).status).toBe(201);
    land();

    const moved = await relocate();
    expect(moved.status).toBe(200);
    const landed = path.join(projectRoot, 'docs/reports/launch.md');
    expect(moved.json.relocated).toEqual([expect.objectContaining({
        document_id: document.id, from_path: file, to_path: landed, revision_id: revision.id,
        registered_hash: revision.content_hash, landed_hash: sha256(fs.readFileSync(landed)),
        from_deliverable_key: 'launch-report', to_deliverable_key: 'launch-report',
    })]);
    expect(moved.json.left).toEqual([]);
    git(projectRoot, 'worktree', 'remove', worktree);

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json).toMatchObject({ file_state: 'ok', document: { id: document.id, path: landed, deliverable_key: 'launch-report', current_revision_id: revision.id, requires_review: true } });
    expect(read.json.version.revision_count).toBe(1);
    expect(read.json.review.id).toBe(review.id);
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review.comments).toEqual([expect.objectContaining({ body: 'Reads well.' })]);
    const decision = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id });
    expect(decision.status).toBe(201);
    expect(decision.json.decision).toMatchObject({ revision_id: revision.id, content_hash: revision.content_hash });
    expect(count('SELECT COUNT(*) AS n FROM review_document_revisions WHERE document_id = ?', document.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM review_documents')).toBe(1);
});

test('an HTML prototype, image and design screen stay servable and reviewable from their landed bytes after worktree removal', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    const cases = [
        { kind: 'prototype', file: 'preview.html', bytes: '<main>Ready</main>', key: 'primary' },
        { kind: 'image', file: 'poster.png', bytes: png, key: 'primary' },
        { kind: 'design', file: 'flow.design.json', bytes: JSON.stringify({
            format: 'nexus-design-package/1', title: 'Flow', screens: [{ id: 'home', title: 'Home', file: 'screens/home.png' }],
        }), key: 'screen:home' },
    ];
    write(worktree, 'screens/home.png', png);
    const registrations = [];
    for (const item of cases) {
        const file = write(worktree, item.file, item.bytes);
        const response = await api('POST', '/api/documents', { ...declared(file, { key: item.file }), kind: item.kind });
        expect(response.status).toBe(201);
        registrations.push({ ...item, ...response.json });
    }
    land();
    const moved = await relocate();
    expect(moved.json.left).toEqual([]);
    expect(moved.json.relocated).toHaveLength(cases.length);
    git(projectRoot, 'worktree', 'remove', worktree);
    // Exercise the exact, disk-only fallback independently of capture. This also
    // models old missing blobs and the video size class deliberately kept on disk.
    fs.rmSync(process.env.NEXUS_REVIEW_BLOB_DIR, { recursive: true, force: true });
    for (const { document, revision, key, bytes, kind } of registrations) {
        const url = `/api/documents/${document.id}`;
        const pinned = `?revision=${revision.id}`;
        const ready = await api('GET', url + '/readiness' + pinned);
        expect(ready.json).toMatchObject({ ready: true, revision_id: revision.id, checks: [
            expect.objectContaining({ asset_key: key, status: 'servable', source: 'disk' }),
        ] });
        const asset = await nativeFetch(base + url + '/assets/' + encodeURIComponent(key) + pinned, {
            headers: { 'x-test-user': 'local_user' },
        });
        expect(asset.status).toBe(200);
        expect(Buffer.from(await asset.arrayBuffer())).toEqual(kind === 'prototype' ? Buffer.from(bytes) : png);
        const detail = await api('GET', url);
        expect(detail.json).toMatchObject({ file_state: 'ok', reviewable: { ok: true }, readiness: { ready: true },
            document: { current_revision_id: revision.id, requires_review: true } });
    }
    // Pin the old image, then replace its landed file with different bytes of the same length.
    const poster = registrations.find(item => item.kind === 'image');
    const edited = Buffer.from(png);
    edited[edited.length - 1] ^= 1;
    write(projectRoot, poster.file, edited);
    fs.rmSync(process.env.NEXUS_REVIEW_BLOB_DIR, { recursive: true, force: true });
    const pinnedUrl = `/api/documents/${poster.document.id}/readiness?revision=${poster.revision.id}`;
    expect((await api('GET', pinnedUrl)).json).toMatchObject({ ready: false, checks: [{ asset_key: 'primary', status: 'changed' }] });
});

test('without the move, the same landing leaves the document undecidable once the worktree is removed', async () => {
    const file = write(worktree, 'docs/reports/launch.md', '# Launch\n');
    const { document, revision } = (await api('POST', '/api/documents', declared(file, { key: 'launch-report' }))).json;
    land();
    git(projectRoot, 'worktree', 'remove', worktree);
    const decision = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id });
    expect(decision.status).toBe(409);
    expect(decision.json).toMatchObject({ code: 'file_unavailable', file_state: 'outside_roots' });
});

test('a landed file with other bytes is not moved and is named with both hashes; no revision is recorded', async () => {
    const changed = write(worktree, 'docs/plan.md', '# Plan\n\nVersion the run reviewed.\n');
    const missing = write(worktree, 'docs/scratch.md', '# Scratch\n');
    const one = (await api('POST', '/api/documents', declared(changed, { key: 'plan' }))).json;
    const two = (await api('POST', '/api/documents', declared(missing, { key: 'scratch' }))).json;
    land();
    // Main moved on after the landing: the same path now holds other bytes, and the scratch file is gone.
    const landedPlan = write(projectRoot, 'docs/plan.md', '# Plan\n\nA later edit on main.\n');
    fs.rmSync(path.join(projectRoot, 'docs/scratch.md'));

    const result = await relocate();
    expect(result.status).toBe(200);
    expect(result.json.relocated).toEqual([]);
    expect(result.json.left).toEqual(expect.arrayContaining([
        expect.objectContaining({
            document_id: one.document.id, title: 'plan.md', reason: 'hash_mismatch', from_path: changed, to_path: landedPlan,
            registered_hash: one.revision.content_hash, landed_hash: sha256(fs.readFileSync(landedPlan)),
        }),
        expect.objectContaining({ document_id: two.document.id, reason: 'landed_file_missing', registered_hash: two.revision.content_hash, landed_hash: null }),
    ]));
    expect(result.json.left[0].registered_hash).not.toBe(result.json.left[0].landed_hash);
    for (const { document, revision } of [one, two]) {
        const row = db.documentReviews.getDocument(document.id);
        expect(row).toMatchObject({ path: document.path, current_revision_id: revision.id });
        expect(count('SELECT COUNT(*) AS n FROM review_document_revisions WHERE document_id = ?', document.id)).toBe(1);
    }
    expect(count('SELECT COUNT(*) AS n FROM review_document_relocations')).toBe(0);
    // Still readable from its captured revision after the worktree goes.
    git(projectRoot, 'worktree', 'remove', '--force', worktree);
    const read = await api('GET', `/api/documents/${one.document.id}`);
    expect(read.json).toMatchObject({ file_state: 'outside_roots', revision: { id: one.revision.id }, content: '# Plan\n\nVersion the run reviewed.\n' });
});

test('a registration without a declaration moves only to a landed file holding the exact bytes of its revision: other line endings or a dropped byte order mark leave it, named with both byte hashes', async () => {
    // [bytes the run registered, bytes at the landed path]. Without a declaration a revision is filed under the hash of
    // its line-normalized text, the same for every pair below, so only the bytes can tell them apart.
    const cases = {
        'same-lf.md': ['# Reviewed\n\nKept.\n', '# Reviewed\n\nKept.\n'],
        'same-crlf.md': ['# Reviewed\r\n\r\nKept.\r\n', '# Reviewed\r\n\r\nKept.\r\n'],
        'lf-to-crlf.md': ['# Reviewed\n', '# Reviewed\r\n'],
        'crlf-to-lf.md': ['# Reviewed\r\n', '# Reviewed\n'],
        'bom-dropped.md': ['﻿# Reviewed\n', '# Reviewed\n'],
    };
    const bytesHash = text => sha256(Buffer.from(text, 'utf8'));
    const landedPath = name => path.join(projectRoot, 'docs', name);
    const registered = {};
    for (const [name, [bytes]] of Object.entries(cases)) {
        const file = write(worktree, `docs/${name}`, bytes);
        const response = await api('POST', '/api/documents', { path: file, title: name, project_id: PROJECT_ID, task_id: TASK_A });
        expect(response.status).toBe(201);
        expect(response.json.document.deliverable_key).toBeNull();
        registered[name] = response.json;
    }
    land();
    // Main changed the line endings or the byte order mark after the landing; the text the reviewer saw is the same.
    for (const [name, [, bytes]] of Object.entries(cases)) write(projectRoot, `docs/${name}`, bytes);

    const result = await relocate();
    expect(result.status).toBe(200);
    expect(result.json.relocated.map(entry => entry.title).sort()).toEqual(['same-crlf.md', 'same-lf.md']);
    for (const name of ['same-lf.md', 'same-crlf.md']) {
        const { document, revision } = registered[name];
        expect(result.json.relocated).toContainEqual(expect.objectContaining({
            document_id: document.id, to_path: landedPath(name), revision_id: revision.id,
            registered_hash: bytesHash(cases[name][0]), landed_hash: sha256(fs.readFileSync(landedPath(name))),
        }));
    }
    // The CRLF revision's identity is its normalized text, not its bytes: the move compared the bytes it holds.
    expect(registered['same-crlf.md'].revision.content_hash).not.toBe(bytesHash(cases['same-crlf.md'][0]));
    expect(result.json.left).toHaveLength(3);
    for (const name of ['lf-to-crlf.md', 'crlf-to-lf.md', 'bom-dropped.md']) {
        const { document, revision } = registered[name];
        const [registeredBytes, landedBytes] = cases[name];
        expect(result.json.left).toContainEqual(expect.objectContaining({
            document_id: document.id, reason: 'hash_mismatch', detail: 'only the line endings or byte order mark differ',
            from_path: document.path, to_path: landedPath(name), revision_id: revision.id,
            registered_hash: bytesHash(registeredBytes), landed_hash: bytesHash(landedBytes),
        }));
        expect(bytesHash(registeredBytes)).not.toBe(bytesHash(landedBytes));
        expect(db.documentReviews.getDocument(document.id)).toMatchObject({ path: document.path, current_revision_id: revision.id, deliverable_key: null });
        expect(count('SELECT COUNT(*) AS n FROM review_document_revisions WHERE document_id = ?', document.id)).toBe(1);
        expect(count('SELECT COUNT(*) AS n FROM review_document_relocations WHERE document_id = ?', document.id)).toBe(0);
    }
    // The CRLF landed file is reported by the hash of its bytes, not by the hash of its normalized text (the revision's).
    const lfToCrlf = result.json.left.find(entry => entry.document_id === registered['lf-to-crlf.md'].document.id);
    expect(lfToCrlf.registered_hash).toBe(registered['lf-to-crlf.md'].revision.content_hash);
    expect(lfToCrlf.landed_hash).not.toBe(registered['lf-to-crlf.md'].revision.content_hash);

    // A moved registration's next capture finds the same revision: capture keeps the identity it always had.
    git(projectRoot, 'worktree', 'remove', worktree);
    for (const name of ['same-lf.md', 'same-crlf.md']) {
        const { document, revision } = registered[name];
        const read = await api('GET', `/api/documents/${document.id}`);
        expect(read.json).toMatchObject({ file_state: 'ok', document: { path: landedPath(name), current_revision_id: revision.id } });
        expect(count('SELECT COUNT(*) AS n FROM review_document_revisions WHERE document_id = ?', document.id)).toBe(1);
    }
    expect(count('SELECT COUNT(*) AS n FROM review_document_relocations')).toBe(2);
});

test('repeating the move, or racing two of them, moves each document once: no duplicate document, revision or record', async () => {
    const file = write(worktree, 'docs/report.md', '# Report\n');
    const { document, revision } = (await api('POST', '/api/documents', declared(file, { key: 'report' }))).json;
    land();
    const [first, second] = await Promise.all([relocate(), relocate()]);
    const moves = [...first.json.relocated, ...second.json.relocated];
    const answered = [...first.json.already_relocated, ...second.json.already_relocated];
    expect(moves).toHaveLength(1);
    expect(answered).toEqual([expect.objectContaining({ document_id: document.id, relocation_id: moves[0].relocation_id })]);
    expect([...first.json.left, ...second.json.left]).toEqual([]);

    git(projectRoot, 'worktree', 'remove', worktree);
    const third = await relocate();
    expect(third.json).toMatchObject({ relocated: [], left: [], already_relocated: [expect.objectContaining({ document_id: document.id, relocation_id: moves[0].relocation_id, to_path: path.join(projectRoot, 'docs/report.md') })] });
    expect(count('SELECT COUNT(*) AS n FROM review_documents')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM review_document_revisions WHERE document_id = ?', document.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM review_document_relocations WHERE document_id = ?', document.id)).toBe(1);
    expect(db.documentReviews.getDocument(document.id).current_revision_id).toBe(revision.id);
    expect(() => db.raw.prepare("UPDATE review_document_relocations SET to_path = 'x'").run()).toThrow(/append-only/);
});

test('a path: key moves with the path, so later registrations from the main checkout land on the same document', async () => {
    const file = write(worktree, 'docs/notes.md', '# Notes\n');
    const first = (await api('POST', '/api/documents', declared(file))).json;
    expect(first.document.deliverable_key).toBe(`path:${file}`);
    land();
    const moved = await relocate();
    const landed = path.join(projectRoot, 'docs/notes.md');
    expect(moved.json.relocated).toEqual([expect.objectContaining({ from_deliverable_key: `path:${file}`, to_deliverable_key: `path:${landed}` })]);
    git(projectRoot, 'worktree', 'remove', worktree);

    // The same bytes registered again from the main checkout, by the same task and by a follow-up task.
    const again = await api('POST', '/api/documents', declared(landed));
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, document: { id: first.document.id, deliverable_key: `path:${landed}` }, revision: { id: first.revision.id } });
    const followUp = await api('POST', '/api/documents', declared(landed, { taskId: TASK_B }));
    expect(followUp.status).toBe(200);
    expect(followUp.json.document.id).toBe(first.document.id);
    // A later revision from the main checkout is a new revision of the same document, and takes the decision.
    fs.writeFileSync(landed, '# Notes\n\nRevised on main.\n');
    const revised = await api('POST', '/api/documents', declared(landed, { taskId: TASK_B }));
    expect(revised.status).toBe(200);
    expect(revised.json.document.id).toBe(first.document.id);
    expect(revised.json.revision.id).not.toBe(first.revision.id);
    expect((await api('POST', `/api/documents/${first.document.id}/decisions`, { decision: 'approve', revision_id: revised.json.revision.id })).status).toBe(201);
    expect(count('SELECT COUNT(*) AS n FROM review_documents')).toBe(1);
});

test('the store refuses a stale revision and an occupied landed path or key; each refusal leaves the registration where it is', async () => {
    const file = write(worktree, 'docs/a.md', '# A\n');
    const keyed = write(worktree, 'docs/b.md', '# B\n');
    const a = (await api('POST', '/api/documents', declared(file, { key: 'a' }))).json;
    const b = (await api('POST', '/api/documents', declared(keyed))).json;
    land();
    const landedA = path.join(projectRoot, 'docs/a.md');
    const landedB = path.join(projectRoot, 'docs/b.md');
    const store = db.documentReviews;
    expect(store.relocateDocument({
        documentId: a.document.id, fromPath: file, toPath: landedA, fromRoot: worktree, toRoot: projectRoot,
        revisionId: 'not-the-current-revision', contentHash: a.revision.content_hash, source: 'landing', actorId: 'test',
    })).toMatchObject({ outcome: 'revision_changed' });
    // Another document of the same task already holds a.md at the landed path; another document holds b.md's landed path: key.
    const holderA = store.insertDocument({ title: 'holder', path: landedA, project_id: PROJECT_ID, task_id: TASK_A, deliverable_key: 'holder-a' });
    const holderB = store.insertDocument({ title: 'holder', path: landedB, project_id: PROJECT_ID, task_id: TASK_B, deliverable_key: `path:${landedB}` });
    const result = await relocate();
    expect(result.json.relocated).toEqual([]);
    expect(result.json.left).toEqual(expect.arrayContaining([
        expect.objectContaining({ document_id: a.document.id, reason: 'path_occupied', detail: `occupied by document ${holderA.id}` }),
        expect.objectContaining({ document_id: b.document.id, reason: 'key_occupied', detail: `occupied by document ${holderB.id}` }),
    ]));
    expect(store.getDocument(a.document.id).path).toBe(file);
    expect(store.getDocument(b.document.id)).toMatchObject({ path: keyed, deliverable_key: `path:${keyed}` });
});

test('the request is validated; with no landed checkout nothing moves and every registration is named', async () => {
    const file = write(worktree, 'docs/report.md', '# Report\n');
    const { document } = (await api('POST', '/api/documents', declared(file, { key: 'report' }))).json;
    // A refused value is `invalid_relocation`; a request in a shape this route does not read (a field or a source it
    // does not know, a required field left out: a client of another version) is `unsupported_relocation`.
    const refusals = [
        [{ from_root: 'relative/path' }, 400, 'invalid_relocation'],
        [{ from_root: `${worktree}/` }, 400, 'invalid_relocation'],
        [{ from_root: '/' }, 400, 'invalid_relocation'],
        [{ from_root: undefined }, 400, 'unsupported_relocation'],
        [{ to_root: undefined }, 400, 'unsupported_relocation'],
        [{ to_root: path.join(worktree, 'docs') }, 400, 'invalid_relocation'],
        [{ to_root: path.join(workspace, 'nowhere') }, 409, 'to_root_missing'],
        [{ source: 'cleanup' }, 400, 'unsupported_relocation'],
        [{ task_id: '' }, 400, 'invalid_relocation'],
        [{ reason: 'x'.repeat(501) }, 400, 'invalid_relocation'],
        [{ extra: true }, 400, 'unsupported_relocation'],
    ];
    for (const [body, status, code] of refusals) {
        const sent = { from_root: worktree, to_root: projectRoot, ...body };
        for (const key of Object.keys(body)) if (body[key] === undefined) delete sent[key];
        const response = await api('POST', '/api/documents/relocations', sent);
        const label = Object.entries(body).map(([key, value]) => `${key}=${value === undefined ? '(left out)' : JSON.stringify(value)}`).join(' ');
        expect([label, response.status, response.json && response.json.code]).toEqual([label, status, code]);
    }
    const notAnObject = await nativeFetch(base + '/api/documents/relocations', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'local_user' }, body: '["not", "an", "object"]',
    });
    expect([notAnObject.status, (await notAnObject.json()).code]).toEqual([400, 'invalid_relocation']);
    expect((await api('POST', '/api/documents/relocations', { from_root: worktree, to_root: projectRoot }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const none = await relocate({ to_root: null });
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ relocated: [], already_relocated: [], left: [expect.objectContaining({ document_id: document.id, reason: 'no_landed_checkout', to_path: null })] });
    expect(db.documentReviews.getDocument(document.id).path).toBe(file);
});
