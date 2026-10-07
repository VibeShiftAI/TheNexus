/** Synthetic only: isolated SQLite/project files and no sender/provider. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const createDocumentsRouter = require('../routes/documents');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');

const keys = { operator: 'operator-'.repeat(8), runtime: 'runtime-'.repeat(8), executor: 'executor-'.repeat(8) };
const envelope = { to: 'member@example.test', cc: ['copy@example.test'], subject: 'Review invitation', text: 'Exact body.\nSecond line.', attachments: [] };
const provenance = { member_id: 'member-1', project_id: 'project-1', task_id: 'task-1', source_refs: ['synthetic:source-1'] };
let raw, store, root, file, server, base, document, revision;
async function api(method, suffix, body, role = 'runtime', extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (keys[role]) headers.authorization = `Bearer ${keys[role]}`;
    if (role === 'access_user' || role === 'access_device') headers['x-test-access'] = role;
    if (role === 'service') headers['x-test-service'] = '1';
    const res = await fetch(base + suffix, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: res.headers.get('content-type')?.includes('json') ? await res.json() : {} };
}
const url = suffix => `/${document.id}/outgoing${suffix || ''}`;
async function prepare(extra = {}) {
    return api('PUT', url(), { revision_id: revision.id, envelope, provenance, ...extra });
}
async function approve(outgoing, role = 'operator', extra = {}) {
    return api('POST', url('/decision'), { decision: 'approve_send', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash, ...extra }, role);
}
async function claim(outgoing) {
    return api('POST', url('/claim'), { revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash, delivery_id: outgoing.delivery_id });
}
beforeEach(async () => {
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = keys.operator;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = keys.runtime;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = keys.executor;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-outgoing-test-')));
    file = path.join(root, 'draft.md');
    fs.writeFileSync(file, '# Outgoing draft\n\nReview exact envelope below.\n', 'utf8');
    raw = new Database(':memory:');
    initializeDocumentReviews(raw);
    store = createDocumentReviewStore(raw);
    const project = { id: 'project-1', name: 'Synthetic', path: root };
    const task = { id: 'task-1', project_id: project.id, name: 'Draft' };
    const db = { documentReviews: store, getProjects: async () => [project], getProject: async id => id === project.id ? project : null, getTask: async id => id === task.id ? task : null };
    const authorizeDecision = createDocumentDecisionAuthority({ authenticateOperator: { inspect: async req => ({ operator: Boolean(req.get('x-test-access')), identity: req.get('x-test-access') === 'access_device' ? 'device' : 'user' }) } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'local_user', is_service: Boolean(req.get('x-test-service')) }; next(); });
    app.use(createDocumentsRouter({ db, authorizeDecision }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const registered = await api('POST', '/', { path: file, title: 'Outgoing', project_id: project.id, task_id: task.id, deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } });
    expect(registered.status).toBe(201);
    ({ document, revision } = registered.json);
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    delete process.env.NEXUS_DOCUMENT_APPROVAL_KEY;
});

test('prepare is retry-stable and a direct operator decision snapshots the exact envelope for one atomic claim', async () => {
    const made = await prepare();
    expect(made.status).toBe(200);
    const outgoing = made.json.outgoing;
    expect(outgoing).toMatchObject({ status: 'draft', envelope, provenance, revision_id: revision.id, content_hash: revision.content_hash });
    expect((await prepare()).json.outgoing).toEqual(outgoing);
    const approved = await approve(outgoing);
    expect(approved.status).toBe(200);
    expect(approved.json.outgoing).toMatchObject({ status: 'approved', grant: { authority: 'operator_credential', envelope, revision_id: revision.id, envelope_hash: outgoing.envelope_hash } });
    const claims = await Promise.all([claim(outgoing), claim(outgoing), claim(outgoing)]);
    expect(claims.filter(r => r.json.claimed)).toHaveLength(1);
    expect(claims.every(r => r.status === 200 && r.json.outgoing.status === 'delivering')).toBe(true);
    const receipt = { delivery_id: outgoing.delivery_id, status: 'sent', message_id: 'synthetic-provider-id' };
    expect((await api('POST', url('/receipt'), receipt)).json.outgoing.status).toBe('sent');
    expect((await api('POST', url('/receipt'), receipt)).json.outgoing.status).toBe('sent');
    expect((await claim(outgoing)).json.claimed).toBe(false);
    expect((await prepare()).status).toBe(409);
});

test.each(['access_user', 'access_device', 'operator'])('%s can explicitly grant send', async role => {
    const { json: { outgoing } } = await prepare();
    expect((await approve(outgoing, role)).status).toBe(200);
});
test.each(['runtime', 'executor', 'unsigned', 'service'])('%s cannot grant send', async role => {
    const { json: { outgoing } } = await prepare();
    expect((await approve(outgoing, role)).status).toBe(403);
    expect((await claim(outgoing)).status).toBe(409);
});
test.each(['operator', 'executor', 'unsigned', 'access_user'])('%s cannot prepare or claim runtime work', async role => {
    expect((await api('PUT', url(), { revision_id: revision.id, envelope, provenance }, role)).status).toBe(403);
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    expect((await api('POST', url('/claim'), { revision_id: revision.id, envelope_hash: outgoing.envelope_hash, delivery_id: outgoing.delivery_id }, role)).status).toBe(403);
});
test.each([
    { to: 'other@example.test' }, { cc: ['new@example.test'] }, { subject: 'Changed' }, { text: 'Changed body' },
])('envelope change %j invalidates a grant and old request cannot overwrite it', async change => {
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    const altered = { ...envelope, ...change };
    expect((await prepare({ envelope: altered })).status).toBe(409);
    const updated = await prepare({ envelope: altered, expected_envelope_hash: outgoing.envelope_hash });
    expect(updated.status).toBe(200);
    expect(updated.json.outgoing.status).toBe('draft');
    expect(updated.json.outgoing.envelope_hash).not.toBe(outgoing.envelope_hash);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await prepare({ expected_envelope_hash: outgoing.envelope_hash })).status).toBe(409);
    expect((await claim(updated.json.outgoing)).status).toBe(409);
});
test('nonempty attachments, header injection, unknown envelope fields, and changed provenance fail closed', async () => {
    expect((await prepare({ envelope: { ...envelope, attachments: [{ path: '/tmp/secret' }] } })).status).toBe(400);
    expect((await prepare({ envelope: { ...envelope, subject: 'Hi\r\nBcc: hidden@example.test' } })).status).toBe(400);
    expect((await prepare({ envelope: { ...envelope, bcc: ['hidden@example.test'] } })).status).toBe(400);
    const { json: { outgoing } } = await prepare();
    expect((await prepare({ provenance: { ...provenance, member_id: 'other' }, expected_envelope_hash: outgoing.envelope_hash })).status).toBe(409);
});
test('capturing changed document bytes permanently invalidates approval even after edit then revert', async () => {
    const original = fs.readFileSync(file, 'utf8');
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    fs.writeFileSync(file, '# Changed\n', 'utf8');
    await api('GET', `/${document.id}`);
    fs.writeFileSync(file, original, 'utf8');
    await api('GET', `/${document.id}`);
    expect((await claim(outgoing)).status).toBe(409);
    expect((await approve(outgoing)).status).toBe(409);
    const updated = await prepare({ expected_envelope_hash: outgoing.envelope_hash });
    expect(updated.json.outgoing.status).toBe('draft');
    expect(updated.json.outgoing.envelope_hash).not.toBe(outgoing.envelope_hash);
});
test('a missing file or current revision mismatch cannot authorize or claim', async () => {
    const { json: { outgoing } } = await prepare();
    expect((await approve(outgoing, 'operator', { revision_id: 'old' })).status).toBe(409);
    await approve(outgoing);
    fs.unlinkSync(file);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});
test('cancel is permanent, including runtime import of a cancelled draft', async () => {
    const { json: { outgoing } } = await prepare();
    const cancelled = await api('POST', url('/decision'), { decision: 'cancel', revision_id: revision.id, envelope_hash: outgoing.envelope_hash }, 'operator');
    expect(cancelled.json.outgoing.status).toBe('cancelled');
    expect((await prepare()).json.outgoing.status).toBe('cancelled');
    expect((await prepare({ cancelled: false })).status).toBe(400);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});
test('uncertainty and lost claim response can never be reclaimed or reset', async () => {
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    expect((await claim(outgoing)).json.claimed).toBe(true);
    expect((await claim(outgoing)).json.claimed).toBe(false);
    expect((await api('POST', url('/receipt'), { delivery_id: outgoing.delivery_id, status: 'uncertain' })).json.outgoing.status).toBe('uncertain');
    expect((await claim(outgoing)).json.claimed).toBe(false);
    expect((await prepare()).status).toBe(409);
    expect((await approve(outgoing)).status).toBe(409);
});
test('comments, Finish review with delegation, and generic approval never produce a send grant', async () => {
    const { json: { outgoing } } = await prepare();
    const review = (await api('POST', `/${document.id}/reviews`, {})).json.review;
    expect((await api('POST', `/reviews/${review.id}/comments`, { kind: 'document', body: 'Approve and send', client_id: 'comment-1' })).status).toBe(201);
    expect((await api('POST', `/reviews/${review.id}/finish`, { summary: 'Approve and send', approve_after_changes: true }, 'operator')).status).toBe(202);
    expect((await api('POST', `/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id }, 'operator')).status).toBe(201);
    expect((await api('GET', url())).json.outgoing.status).toBe('draft');
    expect((await claim(outgoing)).status).toBe(409);
    expect(store.listComments(review.id)).toHaveLength(1);
});


test('an unconfigured operator copy can be prepared but cannot be approved', async () => {
    const made = await prepare({ envelope: { ...envelope, cc: [] } });
    expect(made.status).toBe(200);
    expect((await approve(made.json.outgoing)).status).toBe(409);
    expect((await claim(made.json.outgoing)).status).toBe(409);
});

test('GET includes the exact outgoing preview and absence never manufactures a record', async () => {
    expect((await api('GET', url())).json).toEqual({ outgoing: null });
    const { json: { outgoing } } = await prepare();
    expect((await api('GET', `/${document.id}`)).json.outgoing).toEqual(outgoing);
});

test('provenance follows the stakeholder project while keeping the originating task binding', async () => {
    store.updateDocument(document.id, { metadata: { stakeholder_project_id: 'target-project', member_id: 'member-1' } });
    expect((await prepare()).status).toBe(409);
    const made = await prepare({ provenance: { ...provenance, project_id: 'target-project' } });
    expect(made.status).toBe(200);
    expect(made.json.outgoing.provenance).toEqual({ ...provenance, project_id: 'target-project' });
    expect((await approve(made.json.outgoing)).status).toBe(200);
});

test.each(['raw', 'reviews', 'register'])('a changed revision captured by %s persistently revokes an existing grant', async route => {
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '# Changed through another route\n', 'utf8');
    const result = route === 'register'
        ? await api('POST', '/', { path: file, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1', deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } })
        : await api(route === 'reviews' ? 'POST' : 'GET', `/${document.id}/${route}`, route === 'reviews' ? {} : undefined);
    expect(result.status).toBeLessThan(300);
    fs.writeFileSync(file, original, 'utf8');
    await api('GET', `/${document.id}`);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
    expect(store.getOutgoing(document.id)).toMatchObject({ status: 'draft', grant: null });
});

test('observing a missing file revokes the grant permanently even if identical bytes return', async () => {
    const { json: { outgoing } } = await prepare();
    await approve(outgoing);
    const original = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    await api('GET', url());
    fs.writeFileSync(file, original, 'utf8');
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});

test('envelope A -> B -> A has a new opaque version and preserves the logical delivery identifier', async () => {
    const first = (await prepare()).json.outgoing;
    await approve(first);
    const second = (await prepare({ envelope: { ...envelope, subject: 'Changed' }, expected_envelope_hash: first.envelope_hash })).json.outgoing;
    const third = (await prepare({ expected_envelope_hash: second.envelope_hash })).json.outgoing;
    expect(third.envelope_hash).not.toBe(first.envelope_hash);
    expect(third.delivery_id).toBe(first.delivery_id);
    expect((await approve(first)).status).toBe(409);
    expect((await claim(first)).status).toBe(409);
    expect((await prepare({ expected_envelope_hash: first.envelope_hash })).status).toBe(409);
});

test('a stale cancellation cannot cancel the newer envelope and a current cancellation cannot be rearmed', async () => {
    const first = (await prepare()).json.outgoing;
    const second = (await prepare({ envelope: { ...envelope, subject: 'Changed' }, expected_envelope_hash: first.envelope_hash })).json.outgoing;
    const cancel = outgoing => api('POST', url('/decision'), { decision: 'cancel', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash }, 'operator');
    expect((await cancel(first)).status).toBe(409);
    expect((await cancel(second)).json.outgoing.status).toBe('cancelled');
    expect((await cancel(second)).json.outgoing.status).toBe('cancelled');
    expect((await prepare({ expected_envelope_hash: second.envelope_hash })).status).toBe(409);
    expect((await api('POST', url('/receipt'), { delivery_id: second.delivery_id, status: 'sent' })).status).toBe(409);
});

test('receipt requires a claim, exact identity, runtime authority and cannot turn uncertainty into sent', async () => {
    const outgoing = (await prepare()).json.outgoing;
    const receipt = { delivery_id: outgoing.delivery_id, status: 'sent', message_id: 'synthetic-id' };
    expect((await api('POST', url('/receipt'), receipt)).status).toBe(409);
    await approve(outgoing);
    expect((await api('POST', url('/claim'), { revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash, delivery_id: 'wrong' })).status).toBe(409);
    await claim(outgoing);
    for (const role of ['operator', 'executor', 'unsigned', 'access_device']) {
        expect((await api('POST', url('/receipt'), receipt, role)).status).toBe(403);
    }
    expect((await api('POST', url('/receipt'), { ...receipt, delivery_id: 'wrong' })).status).toBe(409);
    expect((await api('POST', url('/receipt'), { ...receipt, status: 'failed' })).status).toBe(400);
    const uncertain = { delivery_id: outgoing.delivery_id, status: 'uncertain' };
    expect((await api('POST', url('/receipt'), uncertain)).status).toBe(200);
    expect((await api('POST', url('/receipt'), uncertain)).status).toBe(200);
    expect((await api('POST', url('/receipt'), receipt)).status).toBe(409);
    expect((await claim(outgoing)).json.claimed).toBe(false);
});

test('claimed state survives a recreated store and later document edits without a second claim', async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    expect((await claim(outgoing)).json.claimed).toBe(true);
    fs.writeFileSync(file, '# Later edit\n', 'utf8');
    await api('GET', `/${document.id}`);
    const restored = createDocumentReviewStore(raw);
    expect(restored.getOutgoing(document.id).status).toBe('delivering');
    expect(restored.claimOutgoing(document.id, outgoing).claimed).toBe(false);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await prepare()).status).toBe(409);
});


test('a cross-site request cannot record a browser send grant', async () => {
    const outgoing = (await prepare()).json.outgoing;
    const result = await api('POST', url('/decision'), { decision: 'approve_send', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash }, 'access_user', { 'sec-fetch-site': 'cross-site' });
    expect(result.status).toBe(403);
    expect((await claim(outgoing)).status).toBe(409);
});


test('new source references require CAS and fresh review while retaining the logical recipient identity', async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    const nextProvenance = { ...provenance, source_refs: ['synthetic:source-1', 'synthetic:source-2'] };
    expect((await prepare({ provenance: nextProvenance })).status).toBe(409);
    const revised = await prepare({ provenance: nextProvenance, expected_envelope_hash: outgoing.envelope_hash });
    expect(revised.status).toBe(200);
    expect(revised.json.outgoing).toMatchObject({ status: 'draft', grant: null, provenance: nextProvenance, delivery_id: outgoing.delivery_id });
    expect(revised.json.outgoing.envelope_hash).not.toBe(outgoing.envelope_hash);
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(revised.json.outgoing)).status).toBe(409);
});

test('append-only events preserve prior exact approvals and the operator cancellation identity', async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    const next = (await prepare({ envelope: { ...envelope, text: 'Replacement body' }, expected_envelope_hash: outgoing.envelope_hash })).json.outgoing;
    await api('POST', url('/decision'), { decision: 'cancel', revision_id: next.revision_id, envelope_hash: next.envelope_hash }, 'operator');
    const history = await api('GET', url('/history'));
    expect(history.status).toBe(200);
    expect(history.json.history.map(event => event.event)).toEqual(['prepared', 'approved', 'prepared', 'cancelled']);
    const approval = history.json.history[1];
    expect(approval.snapshot).toMatchObject({ envelope_hash: outgoing.envelope_hash, envelope, grant: { authority: 'operator_credential', envelope } });
    expect(history.json.history[3]).toMatchObject({ actor_id: 'local_user', authority: 'operator_credential' });
    expect(() => raw.prepare('UPDATE review_document_outgoing_events SET authority = ? WHERE id = ?').run('runtime_credential', approval.id)).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM review_document_outgoing_events WHERE id = ?').run(approval.id)).toThrow(/append-only/);
});

test('history records one claim and receipt despite concurrent and repeated requests', async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    await Promise.all([claim(outgoing), claim(outgoing)]);
    const receipt = { delivery_id: outgoing.delivery_id, status: 'uncertain' };
    await api('POST', url('/receipt'), receipt);
    await api('POST', url('/receipt'), receipt);
    const { json: { history } } = await api('GET', url('/history'));
    expect(history.map(event => event.event)).toEqual(['prepared', 'approved', 'claimed', 'receipt']);
    expect(history.at(-1).snapshot.status).toBe('uncertain');
});

test.each(['member_id', 'stakeholder_project_id', 'commitment_id', 'source_refs'])('changing document metadata.%s then reverting cannot restore the send grant', async key => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    store.updateDocument(document.id, { metadata: { [key]: 'changed' } });
    store.updateDocument(document.id, { metadata: {} });
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});


for (const declared of [true, false]) test(`failed ${declared ? 'declared' : 'legacy'} registration observes missing bytes and persistently revokes`, async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    const original = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    const registration = { path: file, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1' };
    if (declared) registration.deliverable = { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' };
    expect((await api('POST', '/', registration)).status).toBe(404);
    fs.writeFileSync(file, original, 'utf8');
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});

test('a registration rejected for content mismatch still revokes an observed prior send grant', async () => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '# Changed but rejected by the producer hash\n', 'utf8');
    expect((await api('POST', '/', { path: file, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1', expected_content_hash: revision.content_hash,
        deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } })).status).toBe(409);
    fs.writeFileSync(file, original, 'utf8');
    expect((await approve(outgoing)).status).toBe(409);
    expect((await claim(outgoing)).status).toBe(409);
});


test('commitment provenance must exactly match the document metadata, including absent identity', async () => {
    expect((await prepare({ provenance: { ...provenance, commitment_id: 'commitment-1' } })).status).toBe(409);
    store.updateDocument(document.id, { metadata: { commitment_id: 'commitment-1' } });
    expect((await prepare()).status).toBe(409);
    expect((await prepare({ provenance: { ...provenance, commitment_id: 'commitment-2' } })).status).toBe(409);
    expect((await prepare({ provenance: { ...provenance, commitment_id: 'commitment-1' } })).status).toBe(200);
});

test('declared document source selection must match outgoing provenance and equal registration retries preserve approval', async () => {
    store.updateDocument(document.id, { metadata: { source_refs: ['synthetic:other'] } });
    expect((await prepare()).status).toBe(409);
    store.updateDocument(document.id, { metadata: { source_refs: [...provenance.source_refs] } });
    const outgoing = (await prepare()).json.outgoing;
    expect((await approve(outgoing)).status).toBe(200);
    store.updateDocument(document.id, { metadata: { source_refs: [...provenance.source_refs] } });
    expect(store.getOutgoing(document.id).status).toBe('approved');
});


test.each(['dot', 'trimmed-identity', 'directory-symlink', 'file-symlink'])('failed registration through %s identity also persistently revokes', async alias => {
    const outgoing = (await prepare()).json.outgoing;
    await approve(outgoing);
    let candidate = `${root}/./draft.md`;
    if (alias === 'directory-symlink') {
        fs.symlinkSync(root, path.join(root, 'alias-dir'));
        candidate = path.join(root, 'alias-dir', 'draft.md');
    }
    if (alias === 'file-symlink') {
        candidate = path.join(root, 'alias.md');
        fs.symlinkSync(file, candidate);
    }
    const registration = { path: candidate, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1' };
    if (alias === 'trimmed-identity') {
        registration.path = path.join(root, 'unrelated-missing.md');
        registration.task_id = ' task-1 ';
        registration.deliverable = { key: ' synthetic-outgoing ', purpose: 'Review invitation', requires_review: true, intended_action: 'send' };
    }
    const original = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    expect((await api('POST', '/', registration)).status).toBe(404);
    fs.writeFileSync(file, original, 'utf8');
    expect((await claim(outgoing)).status).toBe(409);
});
