/**
 * Client project access (2026-10-02): explicit project-scoped entitlements,
 * uniform denial, revocation, the immutable version-review ledger, replay
 * safety, non-escalation and @praxis/contract conformance.
 *
 * Isolated NEXUS_DB_PATH, synthetic members and projects only: no live
 * Praxis, relay, portal or mail. The operator / runtime keys are synthetic.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createHash } = require('crypto');

const operatorKey = 'synthetic-operator-only-key-123456789';
const runtimeKey = 'synthetic-runtime-only-key-123456789';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const liveSession = () => ({ sha256: sha256('pt_synthetic_portal_session'), expires: new Date(Date.now() + 3600_000).toISOString() });
const DENIED = { error: 'Project access is not granted', code: 'not_entitled' };

let db, server, base, dir;
let project, other, joey, outsider, task, document, foreignDocument;

async function api(method, url, body, { key, session, headers = {} } = {}) {
    const requestHeaders = { 'Content-Type': 'application/json', ...headers };
    if (key) requestHeaders.Authorization = `Bearer ${key}`;
    if (session) {
        requestHeaders['x-client-session-sha256'] = session.sha256;
        requestHeaders['x-client-session-expires'] = session.expires;
    }
    const response = await fetch(`${base}${url}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, json, text };
}
const grant = (projectId, memberId, { key = operatorKey, ...extra } = {}) =>
    api('POST', `/api/projects/${projectId}/client-access/entitlements`, { member_id: memberId, source: 'synthetic test', ...extra }, { key });
const revoke = (projectId, entitlementId, reason, key = operatorKey) =>
    api('POST', `/api/projects/${projectId}/client-access/entitlements/${entitlementId}/revoke`, { reason }, { key });
const listProjects = (memberId, opts = { key: runtimeKey }) => api('GET', `/api/client-access/members/${memberId}/projects`, undefined, opts);
const read = (memberId, projectId, opts = { key: runtimeKey }) => api('GET', `/api/client-access/members/${memberId}/projects/${projectId}`, undefined, opts);
const detail = (memberId, projectId, artifactId, opts = { key: runtimeKey }) =>
    api('GET', `/api/client-access/members/${memberId}/projects/${projectId}/artifacts/${artifactId}`, undefined, opts);
const review = (memberId, projectId, artifactId, body, opts = { key: runtimeKey, session: liveSession() }) =>
    api('POST', `/api/client-access/members/${memberId}/projects/${projectId}/artifacts/${artifactId}/reviews`, body, opts);
const publish = (projectId, body, key = runtimeKey) => api('POST', `/api/projects/${projectId}/client-access/artifacts`, body, { key });
const withdraw = (projectId, artifactId, reason, key = runtimeKey) => api('POST', `/api/projects/${projectId}/client-access/artifacts/${artifactId}/withdraw`, { reason }, { key });
const summary = projectId => api('GET', `/api/projects/${projectId}/client-access`);

function registerDocument(projectId, title, content) {
    const store = db.documentReviews;
    const doc = store.insertDocument({ title, path: path.join(dir, `${title.replace(/\s+/g, '-')}.md`), project_id: projectId, kind: 'document', registered_by: 'test' });
    const revision = store.insertRevision({ document_id: doc.id, content_hash: sha256(content), content, byte_length: Buffer.byteLength(content), line_count: content.split('\n').length });
    store.setCurrentRevision(doc.id, revision.id);
    return { ...store.getDocument(doc.id), revision };
}

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-client-access-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    jest.resetModules();
    db = require('../../db');
    project = await db.upsertProject({
        name: 'Synthetic client app', path: path.join(dir, 'client-app'), description: 'Client-facing description',
        end_state: 'An agreed, tested app launch accepted by the client lead.',
        urls: { production: 'https://preview.example.invalid/app', repo: 'https://git.example.invalid/app', internal_admin: 'https://admin.example.invalid' },
        comms_settings: { weekly_slot: 'Monday 09:00' }, report_template: { brand: 'internal' },
    });
    await db.updateProject(project.id, {
        needs: [{ kind: 'information', description: 'Receive the specification', notes: 'INTERNAL: contact by email, CC Robert',
            knowledge: { question: 'What does the specification require?', satisfaction_test: 'Specification retained', blocking: true, tags: [] } }],
        end_state_criteria: [{ id: 'launch-accepted', kind: 'manual', description: 'Client lead accepted the exact release candidate' }],
        checkpoints: [{ title: 'Clickable prototype accepted', goal: 'The client accepted the exact prototype version',
            criteria: [{ id: 'proto-acceptance', kind: 'manual', description: 'A client-attributed decision references the exact prototype version' }] }],
        expected_checkpoints_revision: null,
        expected_updated_at: project.updated_at,
    });
    project = await db.getProject(project.id);
    other = await db.upsertProject({ name: 'Other client app', path: path.join(dir, 'other-app'), description: 'Someone else' });
    joey = await db.createContact({ name: 'Synthetic client lead', email: 'client-lead@example.invalid' });
    outsider = await db.createContact({ name: 'Synthetic other client', email: 'other-client@example.invalid' });
    await db.linkContactToProject(project.id, joey.id, { role: 'Client lead / Product decision maker', decision_maker: true });
    await db.linkContactToProject(other.id, outsider.id, { role: 'Client lead', decision_maker: true });
    task = await db.createTask({ project_id: project.id, name: 'Build the prototype', description: 'INTERNAL executor brief with credentials context', status: 'in_progress', priority: 2,
        metadata: { client_summary: 'Prototype build in progress', dispatch_secret: 'INTERNAL', stakeholder_gate: { status: 'pending', requested_at: '2026-10-02T00:00:00.000Z' } },
        antigravity_payload: { prompt: 'INTERNAL raw prompt' }, dispatch_instructions: 'INTERNAL dispatch instructions' });
    document = registerDocument(project.id, 'Prototype brief', '# Prototype brief\n\nVersion one of the brief.\n');
    foreignDocument = registerDocument(other.id, 'Other brief', '# Other brief\n');

    const createClientAccessRouters = require('../routes/client-access');
    const createStakeholderRouters = require('../routes/stakeholders');
    const app = express();
    app.use(express.json());
    // Mirrors server.js: the local stub only exists on cockpit prefixes and is not a credential.
    app.use(['/api/projects', '/api/tasks'], (req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
    const routers = createClientAccessRouters({ db });
    const stakeholders = createStakeholderRouters({ db });
    app.use('/api/client-access', routers.client);
    app.use('/api/projects', routers.projects);
    app.use('/api/projects', stakeholders.projects);
    app.use('/api/tasks', stakeholders.tasks);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    server = undefined;
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    jest.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('granting access needs Robert\'s operator credential: the cockpit stub, the runtime key, a wrong key, the bridge header and an unconfigured key all fail closed', async () => {
    expect((await grant(project.id, joey.id, { key: null })).status).toBe(403);
    expect((await grant(project.id, joey.id, { key: runtimeKey })).status).toBe(403);
    expect((await grant(project.id, joey.id, { key: 'synthetic-wrong-key-with-32-characters!!' })).status).toBe(403);
    const bridged = await api('POST', `/api/projects/${project.id}/client-access/entitlements`, { member_id: joey.id }, { key: operatorKey, headers: { 'x-praxis-bridge-token': 'bridge' } });
    expect(bridged.status).toBe(403);
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    expect((await grant(project.id, joey.id)).status).toBe(503);
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    expect((await summary(project.id)).json.entitlements).toEqual([]);
    expect((await read(joey.id, project.id)).status).toBe(403);

    const granted = await grant(project.id, joey.id, { note: 'Authorized by Robert' });
    expect(granted.status).toBe(201);
    expect(granted.json.entitlement).toMatchObject({ member_id: joey.id, project_id: project.id, scope: 'client_project', state: 'active', authority: 'operator_credential', granted_by: 'robert',
        member_snapshot: { id: joey.id, name: 'Synthetic client lead', email: 'client-lead@example.invalid' }, source: 'synthetic test', note: 'Authorized by Robert' });
    const again = await grant(project.id, joey.id);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ duplicate: true, entitlement: { id: granted.json.entitlement.id } });
});

test('a grant requires an existing, active member who is already linked to that project; it never creates membership', async () => {
    expect((await grant(project.id, outsider.id)).status).toBe(409);
    expect((await grant(project.id, 'missing-member')).status).toBe(404);
    expect((await grant('missing-project', joey.id)).status).toBe(404);
    expect((await grant(project.id, '')).status).toBe(400);
    await db.updateContact(joey.id, { status: 'dormant' });
    expect((await grant(project.id, joey.id)).status).toBe(409);
    await db.updateContact(joey.id, { status: 'active' });
    expect((await grant(project.id, joey.id)).status).toBe(201);
    expect((await db.listProjectContacts(project.id)).map(m => m.id)).toEqual([joey.id]);
    expect((await db.listProjectContacts(other.id)).map(m => m.id)).toEqual([outsider.id]);
});

test('an entitled member reads requirements, progress, checkpoints and links, and nothing internal leaves the server', async () => {
    await grant(project.id, joey.id);
    const list = await listProjects(joey.id);
    expect(list.status).toBe(200);
    expect(list.json.projects.map(p => p.id)).toEqual([project.id]);
    const res = await read(joey.id, project.id, { key: runtimeKey, session: liveSession() });
    expect(res.status).toBe(200);
    const ws = res.json;
    expect(ws.member).toEqual({ id: joey.id, name: 'Synthetic client lead', email: 'client-lead@example.invalid' });
    expect(ws.membership).toEqual({ role: 'Client lead / Product decision maker', decision_maker: true });
    expect(ws.project).toMatchObject({ id: project.id, name: 'Synthetic client app', description: 'Client-facing description', status: 'active',
        urls: { production: 'https://preview.example.invalid/app', repo: 'https://git.example.invalid/app' } });
    expect(ws.project.urls.internal_admin).toBeUndefined();
    expect(Object.keys(ws.project).sort()).toEqual(['created_at', 'description', 'id', 'name', 'status', 'updated_at', 'urls']);
    expect(ws.requirements.end_state).toMatch(/accepted by the client lead/);
    expect(ws.requirements.criteria).toEqual([{ id: 'launch-accepted', kind: 'manual', description: 'Client lead accepted the exact release candidate', enabled: true }]);
    expect(ws.requirements.needs).toHaveLength(1);
    expect(ws.requirements.needs[0]).toMatchObject({ description: 'Receive the specification', blocking: true, status: 'open', question: 'What does the specification require?' });
    expect(ws.requirements.needs[0].notes).toBeUndefined();
    expect(ws.checkpoints.items).toHaveLength(1);
    expect(ws.checkpoints.items[0]).toMatchObject({ title: 'Clickable prototype accepted', status: 'pending', current: true, completed_at: null, criteria: [{ id: 'proto-acceptance', kind: 'manual' }] });
    expect(ws.checkpoints.current_id).toBe(ws.checkpoints.items[0].id);
    expect(ws.tasks).toHaveLength(1);
    expect(Object.keys(ws.tasks[0]).sort()).toEqual(['checkpoint_id', 'created_at', 'id', 'last_activity_at', 'name', 'priority', 'request_status', 'status', 'summary', 'updated_at']);
    expect(ws.tasks[0]).toMatchObject({ id: task.id, name: 'Build the prototype', status: 'in_progress', summary: 'Prototype build in progress', request_status: 'pending' });
    expect(JSON.stringify(ws)).not.toMatch(/INTERNAL|dispatch_secret|comms_settings|report_template|weekly_slot|antigravity|credentials/);
    expect(ws.artifacts).toEqual([]);
    expect(ws.decisions).toEqual([]);
    expect(ws.feedback).toEqual([]);
    expect(ws.session).toEqual({ expires_at: expect.any(String) });
});

test('the client surface accepts only the runtime credential: no key, the cockpit stub, the operator key, a wrong key and the bridge header are all refused', async () => {
    await grant(project.id, joey.id);
    expect((await read(joey.id, project.id, {})).status).toBe(403);
    expect((await read(joey.id, project.id, { key: operatorKey })).status).toBe(403);
    expect((await read(joey.id, project.id, { key: 'synthetic-wrong-key-with-32-characters!!' })).status).toBe(403);
    expect((await read(joey.id, project.id, { key: runtimeKey, headers: { 'x-praxis-bridge-token': 'bridge' } })).status).toBe(403);
    expect((await listProjects(joey.id, {})).status).toBe(403);
    expect((await review(joey.id, project.id, 'any', { decision: 'comment' }, { key: operatorKey, session: liveSession() })).status).toBe(403);
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    expect((await read(joey.id, project.id)).status).toBe(503);
});

test('another member, another project, unknown ids and the decision-maker flag alone are denied with one indistinguishable shape', async () => {
    await grant(project.id, joey.id);
    const denials = await Promise.all([
        read(outsider.id, project.id),            // linked PDM of another project
        read(joey.id, other.id),                  // entitled member, wrong project
        read(joey.id, 'no-such-project'),         // entitled member, nonexistent project
        read('no-such-member', project.id),       // unknown member
        read(outsider.id, other.id),              // PDM on own project but never entitled
        detail(outsider.id, project.id, 'any'),
        review(outsider.id, project.id, 'any', { decision: 'comment', body: 'x' }),
    ]);
    for (const denial of denials) {
        expect(denial.status).toBe(403);
        expect(denial.json).toEqual(DENIED);
    }
    expect((await listProjects(outsider.id)).json.projects).toEqual([]);
    expect((await listProjects('no-such-member')).json.projects).toEqual([]);
});

test('revoking the entitlement, unlinking the member, dormancy, an identity edit and deletion each deny every scoped operation, including replay of an earlier decision; a fresh grant restores it', async () => {
    const first = (await grant(project.id, joey.id)).json.entitlement;
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const accept = { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'portal-decision-1' };
    const accepted = await review(joey.id, project.id, artifact.id, accept);
    expect(accepted.status).toBe(201);
    let n = 0;
    const comment = () => ({ decision: 'comment', version_hash: artifact.version_hash, client_decision_id: `comment-${++n}`, body: 'Feedback' });
    // The whole scoped surface: project list, workspace, artifact detail, a new review and a replay of the acknowledged acceptance.
    const everywhere = async () => ({
        list: (await listProjects(joey.id)).json.projects.map(p => p.id),
        read: await read(joey.id, project.id),
        detail: await detail(joey.id, project.id, artifact.id),
        write: await review(joey.id, project.id, artifact.id, comment()),
        replay: await review(joey.id, project.id, artifact.id, accept),
    });
    const expectDeniedEverywhere = async () => {
        const result = await everywhere();
        expect(result.list).toEqual([]);
        for (const op of ['read', 'detail', 'write', 'replay']) {
            expect(result[op].status).toBe(403);
            expect(result[op].json).toEqual(DENIED);
        }
    };
    const expectAllowedEverywhere = async () => {
        const result = await everywhere();
        expect(result.list).toEqual([project.id]);
        expect(result.read.status).toBe(200);
        expect(result.detail.status).toBe(200);
        expect(result.write.status).toBe(201);
        expect(result.replay.status).toBe(200);
        expect(result.replay.json).toMatchObject({ duplicate: true, review: { id: accepted.json.review.id } });
    };
    await expectAllowedEverywhere();

    expect((await revoke(project.id, first.id, 'Engagement paused', runtimeKey)).status).toBe(403);
    expect((await revoke(project.id, first.id, 'Engagement paused', null)).status).toBe(403);
    const revoked = await revoke(project.id, first.id, 'Engagement paused');
    expect(revoked.status).toBe(200);
    expect(revoked.json.entitlement).toMatchObject({ state: 'revoked', revoked: { reason: 'Engagement paused', by: 'robert', authority: 'operator_credential' } });
    await expectDeniedEverywhere();
    expect((await revoke(project.id, first.id, 'again')).json.duplicate).toBe(true);
    expect((await revoke(other.id, first.id, 'wrong project')).status).toBe(404);

    const second = (await grant(project.id, joey.id)).json.entitlement;
    expect(second.id).not.toBe(first.id);
    await expectAllowedEverywhere();

    await db.unlinkContactFromProject(project.id, joey.id);
    await expectDeniedEverywhere();
    expect((await summary(project.id)).json.entitlements.find(e => e.id === second.id).access).toBe('not_linked');
    await db.linkContactToProject(project.id, joey.id, { role: 'Client lead', decision_maker: true });
    await expectAllowedEverywhere();

    await db.updateContact(joey.id, { status: 'dormant' });
    await expectDeniedEverywhere();
    expect((await summary(project.id)).json.entitlements.find(e => e.id === second.id).access).toBe('member_dormant');
    await db.updateContact(joey.id, { status: 'active' });
    await expectAllowedEverywhere();

    await db.updateContact(joey.id, { email: 'someone-else@example.invalid' });
    await expectDeniedEverywhere();
    expect((await summary(project.id)).json.entitlements.find(e => e.id === second.id).access).toBe('identity_changed');
    const third = await grant(project.id, joey.id);
    expect(third.status).toBe(201);
    expect(third.json.entitlement.member_snapshot.email).toBe('someone-else@example.invalid');
    await expectAllowedEverywhere();
    const entitlements = (await summary(project.id)).json.entitlements;
    expect(entitlements.map(e => e.state)).toEqual(['revoked', 'revoked', 'active']);
    expect(entitlements[1].revoked.reason).toBe('identity_changed_regrant');
    expect(entitlements.map(e => e.access)).toEqual(['revoked', 'revoked', 'granted']);

    // Deleting the member cascades its links but leaves the ledger intact and every operation denied.
    await db.deleteContact(joey.id);
    await expectDeniedEverywhere();
    expect((await summary(project.id)).json.entitlements.map(e => e.access)).toEqual(['revoked', 'revoked', 'member_missing']);
    expect((await summary(project.id)).json.reviews.filter(r => r.decision === 'accept')).toHaveLength(1);
});

test('publishing binds one exact version; duplicates, foreign documents, bad links, unknown checkpoints and foreign tasks are refused', async () => {
    await grant(project.id, joey.id);
    expect((await publish(project.id, { kind: 'document', title: 'Brief', document_id: document.id }, null)).status).toBe(403);
    const published = await publish(project.id, { kind: 'document', title: 'Prototype brief', document_id: document.id, checkpoint_id: project.checkpoints.items[0].id, task_id: task.id });
    expect(published.status).toBe(201);
    const artifact = published.json.artifact;
    expect(artifact).toMatchObject({ kind: 'document', title: 'Prototype brief', state: 'current', published_by: 'runtime', authority: 'runtime_credential',
        document: { id: document.id, title: 'Prototype brief', revision_id: document.revision.id, content_hash: document.revision.content_hash }, version: document.revision.content_hash.slice(0, 12) });
    expect(artifact.version_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await publish(project.id, { kind: 'document', title: 'Prototype brief', document_id: document.id })).json).toMatchObject({ duplicate: true, artifact: { id: artifact.id } });
    expect((await publish(project.id, { kind: 'document', title: 'Foreign', document_id: foreignDocument.id })).json.code).toBe('document_project_mismatch');
    expect((await publish(project.id, { kind: 'document', title: 'Wrong revision', document_id: document.id, revision_id: foreignDocument.revision.id })).json.code).toBe('document_revision_mismatch');
    expect((await publish(project.id, { kind: 'document', title: 'Missing', document_id: 'nope' })).status).toBe(404);
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', version: 'build-1' })).status).toBe(400);
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', version: 'build-1', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', url: 'https://preview.example.invalid/build-1' })).status).toBe(400);
    expect((await publish(project.id, { kind: 'binary', title: 'Nope', version: '1' })).status).toBe(400);
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', version: 'build-1', url: 'https://preview.example.invalid/build-1', checkpoint_id: 'unknown' })).status).toBe(409);
    const foreignTask = await db.createTask({ project_id: other.id, name: 'Other work', status: 'todo' });
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', version: 'build-1', url: 'https://preview.example.invalid/build-1', task_id: foreignTask.id })).status).toBe(409);
    expect((await publish('missing-project', { kind: 'preview', title: 'Preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).status).toBe(404);
    const preview = await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' }, operatorKey);
    expect(preview.status).toBe(201);
    expect(preview.json.artifact).toMatchObject({ kind: 'preview', url: 'https://preview.example.invalid/build-1', version: 'build-1', published_by: 'robert', authority: 'operator_credential', document: null });

    const shown = await detail(joey.id, project.id, artifact.id);
    expect(shown.status).toBe(200);
    expect(shown.json.artifact.id).toBe(artifact.id);
    expect(shown.json.content).toMatchObject({ content: '# Prototype brief\n\nVersion one of the brief.\n', content_hash: document.revision.content_hash, line_count: 4 });
    expect((await detail(joey.id, project.id, preview.json.artifact.id)).json.content).toBeNull();
    expect((await detail(joey.id, project.id, 'missing')).status).toBe(404);
    expect((await detail(outsider.id, project.id, artifact.id)).json).toEqual(DENIED);
    const ws = (await read(joey.id, project.id)).json;
    expect(ws.artifacts.map(a => a.id)).toEqual([artifact.id, preview.json.artifact.id]);

    const gone = await withdraw(project.id, preview.json.artifact.id, 'Broken build');
    expect(gone.json.artifact).toMatchObject({ state: 'withdrawn', withdrawn: { reason: 'Broken build', by: 'runtime' } });
    expect((await withdraw(project.id, preview.json.artifact.id, 'again')).json.duplicate).toBe(true);
    expect((await withdraw(project.id, preview.json.artifact.id, 'x', null)).status).toBe(403);
    expect((await withdraw(other.id, artifact.id, 'wrong project')).status).toBe(404);
    const v2 = await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-2', url: 'https://preview.example.invalid/build-2', supersedes_id: artifact.id });
    expect(v2.status).toBe(201);
    expect(v2.json.artifact.supersedes_id).toBe(artifact.id);
    expect((await detail(joey.id, project.id, artifact.id)).json.artifact).toMatchObject({ state: 'superseded', superseded_by: v2.json.artifact.id });
    expect((await publish(project.id, { kind: 'preview', title: 'Again', version: 'build-3', url: 'https://preview.example.invalid/build-3', supersedes_id: artifact.id })).json.code).toBe('artifact_already_superseded');
    expect((await publish(project.id, { kind: 'preview', title: 'Again', version: 'build-3', url: 'https://preview.example.invalid/build-3', supersedes_id: 'missing' })).status).toBe(409);
});

test('reviews need a live session assertion and the exact version; acceptance is replay-safe, final per version and distinct from comments', async () => {
    await grant(project.id, joey.id);
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const url = (member, id = artifact.id) => [member, project.id, id];
    const accept = { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'portal-decision-1' };

    expect((await review(...url(joey.id), accept, { key: runtimeKey })).json.code).toBe('session_required');
    expect((await review(...url(joey.id), accept, { key: runtimeKey, session: { sha256: liveSession().sha256, expires: new Date(Date.now() - 1000).toISOString() } })).json.code).toBe('session_expired');
    expect((await review(...url(joey.id), accept, { key: runtimeKey, session: { sha256: 'not-a-hash', expires: liveSession().expires } })).json.code).toBe('session_invalid');
    expect((await review(...url(joey.id), accept, { key: runtimeKey, session: { sha256: liveSession().sha256, expires: 'whenever' } })).json.code).toBe('session_invalid');
    expect((await review(...url(joey.id), { ...accept, decision: 'approve' })).status).toBe(400);
    expect((await review(...url(joey.id), { ...accept, client_decision_id: '' })).status).toBe(400);
    expect((await review(...url(joey.id), { ...accept, version_hash: 'abc' })).status).toBe(400);
    expect((await review(...url(joey.id), { decision: 'comment', version_hash: artifact.version_hash, client_decision_id: 'c0' })).status).toBe(400);
    expect((await review(...url(joey.id, 'missing'), accept)).json.code).toBe('artifact_not_found');
    expect((await review(...url(joey.id), { ...accept, version_hash: sha256('stale version') })).json.code).toBe('version_mismatch');

    const comment = await review(...url(joey.id), { decision: 'comment', version_hash: artifact.version_hash, client_decision_id: 'c1', body: 'Looks promising, the colors are off.' });
    expect(comment.status).toBe(201);
    expect(comment.json.review).toMatchObject({ decision: 'comment', member: { id: joey.id }, artifact_id: artifact.id, version_hash: artifact.version_hash, body: 'Looks promising, the colors are off.' });
    expect(comment.json.artifact.accepted).toEqual([]);
    const changes = await review(...url(joey.id), { decision: 'request_changes', version_hash: artifact.version_hash, client_decision_id: 'c2', body: 'Fix the colors.' });
    expect(changes.status).toBe(201);
    expect(changes.json.artifact.accepted).toEqual([]);
    let ws = (await read(joey.id, project.id)).json;
    expect(ws.decisions).toEqual([]);
    expect(ws.feedback.map(f => f.decision)).toEqual(['comment', 'request_changes']);

    const accepted = await review(...url(joey.id), accept);
    expect(accepted.status).toBe(201);
    expect(accepted.json).toMatchObject({ duplicate: false, evidence_ref: `nexus:client-review:${accepted.json.review.id}`,
        review: { decision: 'accept', client_decision_id: 'portal-decision-1', member: { id: joey.id, email: 'client-lead@example.invalid' }, version_hash: artifact.version_hash, body: '' } });
    expect(accepted.json.artifact.accepted.map(r => r.id)).toEqual([accepted.json.review.id]);
    const replay = await review(...url(joey.id), accept);
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ duplicate: true, review: { id: accepted.json.review.id } });
    expect((await review(...url(joey.id), { ...accept, body: 'different payload' })).json.code).toBe('decision_conflict');
    const secondAccept = await review(...url(joey.id), { ...accept, client_decision_id: 'portal-decision-2' });
    expect(secondAccept.status).toBe(200);
    expect(secondAccept.json).toMatchObject({ duplicate: true, review: { id: accepted.json.review.id } });
    expect((await review(...url(joey.id), { decision: 'request_changes', version_hash: artifact.version_hash, client_decision_id: 'c3', body: 'Changed my mind' })).json.code).toBe('already_accepted');
    expect((await review(...url(joey.id), { decision: 'comment', version_hash: artifact.version_hash, client_decision_id: 'c4', body: 'Thanks' })).status).toBe(201);

    ws = (await read(joey.id, project.id)).json;
    expect(ws.decisions.map(d => d.id)).toEqual([accepted.json.review.id]);
    expect(ws.feedback).toHaveLength(3);
    const ledger = (await summary(project.id)).json;
    expect(ledger.reviews).toHaveLength(4);
    expect(ledger.reviews.find(r => r.decision === 'accept')).toMatchObject({ session_sha256: liveSession().sha256, authority: 'runtime_credential', member_id: joey.id });
    expect(JSON.stringify(ws)).not.toContain(liveSession().sha256);

    const v2 = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-2', url: 'https://preview.example.invalid/build-2', supersedes_id: artifact.id })).json.artifact;
    expect((await review(...url(joey.id), { decision: 'comment', version_hash: artifact.version_hash, client_decision_id: 'c5', body: 'late' })).json.code).toBe('artifact_not_current');
    expect((await review(...url(joey.id, v2.id), { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'd2' })).json.code).toBe('version_mismatch');
    await withdraw(project.id, v2.id, 'Broken');
    expect((await review(...url(joey.id, v2.id), { decision: 'accept', version_hash: v2.version_hash, client_decision_id: 'd3' })).json.code).toBe('artifact_not_current');
    expect((await detail(joey.id, project.id, artifact.id)).json.artifact.accepted.map(r => r.id)).toEqual([accepted.json.review.id]);
});

test('acceptance changes nothing else: tasks, checkpoints, gates and reserved proposals are untouched, and the runtime credential cannot grant or decide', async () => {
    await grant(project.id, joey.id);
    const taskBefore = JSON.stringify(await db.getTask(task.id));
    const projectBefore = JSON.stringify(await db.getProject(project.id));
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1', checkpoint_id: project.checkpoints.items[0].id, task_id: task.id })).json.artifact;
    const accepted = await review(joey.id, project.id, artifact.id, { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'd1' });
    expect(accepted.status).toBe(201);
    expect(JSON.stringify(await db.getTask(task.id))).toBe(taskBefore);
    expect(JSON.stringify(await db.getProject(project.id))).toBe(projectBefore);
    expect((await db.getProject(project.id)).checkpoints.items[0].status).toBe('pending');

    const reserved = await db.createTask({ project_id: project.id, name: 'Invite a reviewer', status: 'idea' });
    const proposal = await api('POST', `/api/tasks/${reserved.id}/stakeholder-proposal`, { kind: 'invitation', member_id: joey.id, content: { message: 'Join the synthetic review.', role: 'Reviewer' } });
    expect(proposal.status).toBe(201);
    const binding = { expected_revision: proposal.json.proposal.revision, content_hash: proposal.json.proposal.content_hash };
    expect((await api('POST', `/api/tasks/${reserved.id}/stakeholder-decision`, { decision: 'approve', ...binding }, { key: runtimeKey })).status).toBe(403);
    expect((await api('POST', `/api/tasks/${reserved.id}/stakeholder-decision`, { decision: 'approve', ...binding })).status).toBe(403);
    expect((await grant(project.id, outsider.id, { key: runtimeKey })).status).toBe(403);
    expect(db.getStakeholderProposal(reserved.id).state).toBe('proposed');
    expect((await read(joey.id, project.id)).json.tasks.find(t => t.id === reserved.id)).toMatchObject({ name: 'Invite a reviewer', request_status: 'pending', summary: null });
});

test('links reach a client only as credential-free http(s) URLs: project settings are filtered on projection, publication refuses anything else, and a stored row is re-checked on read', async () => {
    await grant(project.id, joey.id);
    // Projection: the reviewer's three synthetic values, then a mixed set where only the safe ones survive (normalized).
    const risky = await db.upsertProject({ name: 'Risky links', path: path.join(dir, 'risky-app'), urls: {
        production: 'https://synthetic-user:synthetic-secret@git.example.invalid/repo', repo: 'file:///private/internal-document', docs: 'javascript:alert(1)' } });
    await db.linkContactToProject(risky.id, joey.id, { role: 'Client lead', decision_maker: true });
    expect((await grant(risky.id, joey.id)).status).toBe(201);
    const ws = await read(joey.id, risky.id);
    expect(ws.status).toBe(200);
    expect(ws.json.project.urls).toEqual({});
    expect(JSON.stringify(ws.json)).not.toMatch(/synthetic-secret|synthetic-user|file:\/\/|javascript:/);
    const mixed = await db.upsertProject({ name: 'Mixed links', path: path.join(dir, 'mixed-app'), urls: {
        production: 'HTTPS://app.example.invalid/', repo: 'https://deploy-bot@git.example.invalid/repo', docs: 'https://docs.example.invalid/guide?v=2', internal_admin: 'https://admin.example.invalid' } });
    await db.linkContactToProject(mixed.id, joey.id, { role: 'Client lead', decision_maker: true });
    await grant(mixed.id, joey.id);
    expect((await read(joey.id, mixed.id)).json.project.urls).toEqual({ production: 'https://app.example.invalid/', docs: 'https://docs.example.invalid/guide?v=2' });

    // Publication: every non-http(s) or credential-bearing link is refused for every linked kind.
    const unsafe = ['https://synthetic-user:synthetic-secret@preview.example.invalid/b1', 'https://synthetic-user@preview.example.invalid/b1',
        'javascript:alert(1)', 'file:///private/internal-document', 'ftp://preview.example.invalid/b1', '/relative/preview', 'preview.example.invalid/b1'];
    for (const url of unsafe) {
        const res = await publish(project.id, { kind: 'preview', title: 'Preview', version: 'b1', url });
        expect([res.status, res.json.code]).toEqual([400, 'unsafe_url']);
    }
    expect((await publish(project.id, { kind: 'code', title: 'Code', version: 'abc123', url: 'https://u:p@git.example.invalid/repo' })).json.code).toBe('unsafe_url');
    expect((await publish(project.id, { kind: 'deliverable', title: 'Bundle', version: '1.0', url: 'https://u:p@files.example.invalid/bundle.zip' })).json.code).toBe('unsafe_url');
    expect((await publish(project.id, { kind: 'preview', title: 'Preview', version: 'b1', url: 'https://u:p@preview.example.invalid/b1' }, operatorKey)).json.code).toBe('unsafe_url');
    expect((await read(joey.id, project.id)).json.artifacts).toEqual([]);
    expect((await summary(project.id)).json.artifacts).toEqual([]);
    const clean = await publish(project.id, { kind: 'preview', title: 'Preview', version: 'b1', url: 'HTTPS://preview.example.invalid/b1' });
    expect(clean.status).toBe(201);
    expect(clean.json.artifact.url).toBe('https://preview.example.invalid/b1');
    const { safeHttpUrl } = require('../../db/client-access');
    expect(unsafe.map(safeHttpUrl)).toEqual(unsafe.map(() => null));
    expect(safeHttpUrl(' https://preview.example.invalid/b1 ')).toBe('https://preview.example.invalid/b1');

    // A stored row is re-checked on every read, whatever wrote it: a legacy or tampered link is projected as null, never leaked.
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    raw.prepare(`INSERT INTO client_artifacts(id, project_id, kind, title, version, version_hash, url, published_by, authority, published_at)
        VALUES (?, ?, 'preview', 'Legacy preview', 'legacy', ?, ?, 'legacy', 'legacy', ?)`)
        .run('legacy-artifact', project.id, sha256('legacy'), 'https://synthetic-user:synthetic-secret@preview.example.invalid/legacy', new Date().toISOString());
    raw.close();
    const shown = await detail(joey.id, project.id, 'legacy-artifact');
    expect(shown.status).toBe(200);
    expect(shown.json.artifact).toMatchObject({ id: 'legacy-artifact', url: null });
    for (const body of [(await read(joey.id, project.id)).json, shown.json, (await summary(project.id)).json]) {
        expect(JSON.stringify(body)).not.toMatch(/synthetic-secret|synthetic-user/);
    }
});

test('every acknowledged client_decision_id is reserved against its payload: a second accept key resolves to the one acceptance and can never be reused for a different review', async () => {
    await grant(project.id, joey.id);
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const rv = body => review(joey.id, project.id, artifact.id, { version_hash: artifact.version_hash, ...body });
    const first = await rv({ decision: 'accept', client_decision_id: 'first-key' });
    expect(first.status).toBe(201);
    const second = await rv({ decision: 'accept', client_decision_id: 'second-key' });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ duplicate: true, review: { id: first.json.review.id } });
    // The reviewer's reproduction: reuse of the acknowledged second key for a comment must conflict, never be recorded.
    const reuse = await rv({ decision: 'comment', client_decision_id: 'second-key', body: 'conflicting reuse' });
    expect([reuse.status, reuse.json.code]).toEqual([409, 'decision_conflict']);
    expect([(await rv({ decision: 'request_changes', client_decision_id: 'first-key', body: 'conflicting reuse' })).json.code,
        (await rv({ decision: 'accept', client_decision_id: 'second-key', version_hash: sha256('other version') })).json.code]).toEqual(['decision_conflict', 'decision_conflict']);
    // Identical replays of either key keep returning the one acceptance.
    expect((await rv({ decision: 'accept', client_decision_id: 'first-key' })).json).toMatchObject({ duplicate: true, review: { id: first.json.review.id } });
    expect((await rv({ decision: 'accept', client_decision_id: 'second-key' })).json).toMatchObject({ duplicate: true, review: { id: first.json.review.id } });
    // Comment keys are reserved the same way.
    const comment = await rv({ decision: 'comment', client_decision_id: 'comment-key', body: 'Looks good' });
    expect(comment.status).toBe(201);
    expect((await rv({ decision: 'comment', client_decision_id: 'comment-key', body: 'Different text' })).json.code).toBe('decision_conflict');
    expect((await rv({ decision: 'accept', client_decision_id: 'comment-key' })).json.code).toBe('decision_conflict');
    expect((await rv({ decision: 'comment', client_decision_id: 'comment-key', body: 'Looks good' })).json).toMatchObject({ duplicate: true, review: { id: comment.json.review.id } });
    // One acceptance and one comment exist; every acknowledged key points at the review it answered.
    expect((await summary(project.id)).json.reviews.map(r => r.decision)).toEqual(['accept', 'comment']);
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    expect(raw.prepare('SELECT client_decision_id, review_id FROM client_review_keys ORDER BY client_decision_id').all()).toEqual([
        { client_decision_id: 'comment-key', review_id: comment.json.review.id },
        { client_decision_id: 'first-key', review_id: first.json.review.id },
        { client_decision_id: 'second-key', review_id: first.json.review.id },
    ]);
    raw.close();
    // Reservations survive supersession: acknowledged keys still answer identically while new decisions on the old version are refused.
    await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-2', url: 'https://preview.example.invalid/build-2', supersedes_id: artifact.id });
    expect((await rv({ decision: 'accept', client_decision_id: 'second-key' })).status).toBe(200);
    expect((await rv({ decision: 'accept', client_decision_id: 'third-key' })).json.code).toBe('artifact_not_current');
});

test('upgrade path: a review written before client_review_keys existed is backfilled by initialization, idempotently, and its key then rejects conflicting reuse', async () => {
    await grant(project.id, joey.id);
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    // Seed a pre-repair row: a review in client_reviews with no reservation in client_review_keys.
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const legacy = { id: 'legacy-review', client_decision_id: 'legacy-key', artifact_id: artifact.id, decision: 'accept', body: '', version_hash: artifact.version_hash };
    raw.prepare(`INSERT INTO client_reviews(id, client_decision_id, member_id, project_id, artifact_id, version_hash, decision, body, request_hash,
        session_sha256, session_expires_at, authority, member_snapshot, created_at)
        VALUES (@id, @client_decision_id, @member_id, @project_id, @artifact_id, @version_hash, @decision, @body, @request_hash, @session, @expires, 'runtime_credential', @member_snapshot, @created_at)`)
        .run({ ...legacy, member_id: joey.id, project_id: project.id,
            request_hash: sha256(JSON.stringify({ artifact_id: legacy.artifact_id, body: legacy.body, decision: legacy.decision, version_hash: legacy.version_hash })),
            session: liveSession().sha256, expires: liveSession().expires, member_snapshot: JSON.stringify({ id: joey.id, name: 'Synthetic client lead', email: 'client-lead@example.invalid' }),
            created_at: '2026-10-01T12:00:00.000Z' });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM client_review_keys WHERE client_decision_id = 'legacy-key'").get().n).toBe(0);
    // Initialization runs on every process boot; running it twice must backfill exactly once and change nothing else.
    const { initializeClientAccess } = require('../../db/client-access');
    initializeClientAccess(raw);
    initializeClientAccess(raw);
    expect(raw.prepare("SELECT review_id FROM client_review_keys WHERE client_decision_id = 'legacy-key'").all()).toEqual([{ review_id: 'legacy-review' }]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'client_%_no_%'").get().n).toBe(12);
    raw.close();
    const rv = body => review(joey.id, project.id, artifact.id, { version_hash: artifact.version_hash, ...body });
    const reuse = await rv({ decision: 'comment', client_decision_id: 'legacy-key', body: 'conflicting reuse' });
    expect([reuse.status, reuse.json.code]).toEqual([409, 'decision_conflict']);
    expect((await rv({ decision: 'request_changes', client_decision_id: 'legacy-key', body: 'conflicting reuse' })).json.code).toBe('decision_conflict');
    const replay = await rv({ decision: 'accept', client_decision_id: 'legacy-key' });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ duplicate: true, review: { id: 'legacy-review', decision: 'accept' }, evidence_ref: 'nexus:client-review:legacy-review' });
    expect((await summary(project.id)).json.reviews.map(r => r.id)).toEqual(['legacy-review']);
});

test('an identical publish retry returns the existing version even when it supersedes; competing successors and conflicting predecessors are refused', async () => {
    await grant(project.id, joey.id);
    const a = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const successor = { kind: 'preview', title: 'Prototype preview', version: 'build-2', url: 'https://preview.example.invalid/build-2', supersedes_id: a.id };
    const b = await publish(project.id, successor);
    expect(b.status).toBe(201);
    const retry = await publish(project.id, successor);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ duplicate: true, artifact: { id: b.json.artifact.id, supersedes_id: a.id, state: 'current' } });
    expect((await publish(project.id, { ...successor, supersedes_id: undefined })).json).toMatchObject({ duplicate: true, artifact: { id: b.json.artifact.id } });
    // A different version claiming the same predecessor is a competing successor, not a retry.
    const competing = await publish(project.id, { ...successor, version: 'build-3', url: 'https://preview.example.invalid/build-3' });
    expect([competing.status, competing.json.code]).toEqual([409, 'artifact_already_superseded']);
    // The same identity naming a different predecessor is a conflict, not a retry.
    const side = (await publish(project.id, { kind: 'preview', title: 'Side preview', version: 'side-1', url: 'https://preview.example.invalid/side-1' })).json.artifact;
    const conflict = await publish(project.id, { ...successor, supersedes_id: side.id });
    expect([conflict.status, conflict.json.code]).toEqual([409, 'publish_conflict']);
    expect((await read(joey.id, project.id)).json.artifacts.map(x => [x.version, x.state])).toEqual([['build-1', 'superseded'], ['build-2', 'current'], ['side-1', 'current']]);
});

test('an entitlement lookup that cannot run denies every scoped operation with 503 entitlement_unavailable and serves no stored content', async () => {
    await grant(project.id, joey.id);
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const accept = { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'portal-decision-1' };
    expect((await review(joey.id, project.id, artifact.id, accept)).status).toBe(201);
    expect((await read(joey.id, project.id)).status).toBe(200);
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    raw.exec('DROP TABLE client_project_entitlements');
    raw.close();
    const results = [await listProjects(joey.id), await read(joey.id, project.id), await detail(joey.id, project.id, artifact.id), await review(joey.id, project.id, artifact.id, accept)];
    for (const res of results) {
        expect(res.status).toBe(503);
        expect(res.json).toEqual({ error: 'Entitlement lookup unavailable; project access is denied', code: 'entitlement_unavailable' });
    }
});

test('every ledger table is append-only at the SQLite level', async () => {
    await grant(project.id, joey.id);
    const artifact = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    await review(joey.id, project.id, artifact.id, { decision: 'accept', version_hash: artifact.version_hash, client_decision_id: 'd1' });
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const tables = ['client_project_entitlements', 'client_access_events', 'client_artifacts', 'client_artifact_events', 'client_reviews', 'client_review_keys'];
    for (const table of tables) {
        expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBeGreaterThan(0);
        const column = table === 'client_access_events' || table === 'client_artifact_events' ? 'kind' : table === 'client_reviews' ? 'decision'
            : table === 'client_review_keys' ? 'request_hash' : table === 'client_artifacts' ? 'title' : 'note';
        expect(() => raw.prepare(`UPDATE ${table} SET ${column} = 'tampered'`).run()).toThrow(/immutable/);
        expect(() => raw.prepare(`DELETE FROM ${table}`).run()).toThrow(/immutable/);
    }
    raw.close();
    // Deleting the member cascades its links but leaves the ledger intact and access denied.
    await db.deleteContact(joey.id);
    expect((await read(joey.id, project.id)).json).toEqual(DENIED);
    expect((await summary(project.id)).json.entitlements[0].access).toBe('member_missing');
});

test('list, workspace, artifact detail and review responses conform to @praxis/contract', async () => {
    const contract = require('@praxis/contract');
    await grant(project.id, joey.id);
    const doc = (await publish(project.id, { kind: 'document', title: 'Prototype brief', document_id: document.id })).json.artifact;
    const preview = (await publish(project.id, { kind: 'preview', title: 'Prototype preview', version: 'build-1', url: 'https://preview.example.invalid/build-1' })).json.artifact;
    const accepted = (await review(joey.id, project.id, preview.id, { decision: 'accept', version_hash: preview.version_hash, client_decision_id: 'd1' })).json;
    await review(joey.id, project.id, doc.id, { decision: 'comment', version_hash: doc.version_hash, client_decision_id: 'c1', body: 'Read it.' });
    const list = (await listProjects(joey.id, { key: runtimeKey, session: liveSession() })).json;
    expect(contract.ClientProjectListSchema.parse(list).projects).toHaveLength(1);
    const ws = (await read(joey.id, project.id, { key: runtimeKey, session: liveSession() })).json;
    const parsed = contract.ClientProjectWorkspaceSchema.parse(ws);
    expect(parsed.artifacts.map(a => a.kind)).toEqual(['document', 'preview']);
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.feedback).toHaveLength(1);
    expect(contract.ClientArtifactDetailSchema.parse((await detail(joey.id, project.id, doc.id)).json).content.content).toContain('Version one');
    expect(contract.ClientReviewResponseSchema.parse(accepted).evidence_ref).toBe(contract.clientReviewEvidenceRef(accepted.review.id));
    expect(contract.clientReviewIdFromEvidenceRef(accepted.evidence_ref)).toBe(accepted.review.id);
    expect(contract.clientReviewIdFromEvidenceRef('spine:run-event:1')).toBeNull();
    expect(contract.ClientEntitlementSchema.parse((await summary(project.id)).json.entitlements[0]).state).toBe('active');
    expect(contract.CLIENT_SESSION_HEADERS).toEqual({ sha256: 'x-client-session-sha256', expires: 'x-client-session-expires' });
    // Revision 1.1: the contract itself refuses unsafe links and names every error code the server emits.
    expect(contract.CLIENT_ACCESS_CONTRACT_REVISION).toBe('1.1');
    for (const url of ['https://u:p@preview.example.invalid/b1', 'https://u@preview.example.invalid/b1', 'javascript:alert(1)', 'file:///private/internal-document']) {
        expect(contract.ClientSafeUrlSchema.safeParse(url).success).toBe(false);
        expect(contract.ClientArtifactPublishSchema.safeParse({ kind: 'preview', title: 'Preview', version: 'b1', url }).success).toBe(false);
    }
    expect(contract.ClientSafeUrlSchema.parse('https://preview.example.invalid/b1')).toBe('https://preview.example.invalid/b1');
    const denied = await read(outsider.id, project.id);
    expect(contract.ClientAccessErrorSchema.parse(denied.json).code).toBe('not_entitled');
    expect(contract.CLIENT_ACCESS_ERROR_CODES).toEqual(expect.arrayContaining(['not_entitled', 'entitlement_unavailable', 'decision_conflict', 'version_mismatch', 'unsafe_url', 'publish_conflict']));
});

test('an unavailable database fails closed with 503 on both surfaces', async () => {
    const createClientAccessRouters = require('../routes/client-access');
    const app = express();
    app.use(express.json());
    const routers = createClientAccessRouters({ db: {} });
    app.use('/api/client-access', routers.client);
    app.use('/api/projects', routers.projects);
    const isolated = http.createServer(app);
    await new Promise(resolve => isolated.listen(0, '127.0.0.1', resolve));
    const port = isolated.address().port;
    try {
        const client = await fetch(`http://127.0.0.1:${port}/api/client-access/members/m/projects/p`, { headers: { Authorization: `Bearer ${runtimeKey}` } });
        expect(client.status).toBe(503);
        const cockpit = await fetch(`http://127.0.0.1:${port}/api/projects/p/client-access`);
        expect(cockpit.status).toBe(503);
    } finally {
        await new Promise(resolve => isolated.close(resolve));
    }
});
