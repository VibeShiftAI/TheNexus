/**
 * Operator task origin (2026-10-29): tasks Robert files himself are labelled
 * as his, verifiably, and nothing a request body says can produce that label.
 *
 *   operator:board  board create + a verified operator session
 *   operator:chat   Praxis chat dispatch + a valid operator-task attestation
 *
 * Found by a read-only trace on 2026-10-29: chat-dispatched tasks a10da6d9,
 * 6a2d974d and 91f1f758 carried no source, so executors got Robert's brief
 * wrapped as "untrusted reference data"; board creates were recorded as
 * `nexus-api`, which Praxis's planner holds back under propose posture.
 *
 * The attestation formula is pinned against a raw-crypto reference that
 * Praxis pins as well (Praxis tests/operator_provenance.test.ts): change the
 * formula on both sides or on neither.
 */
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');

const {
  classifySource,
  isOperatorOriginSource,
  normalizeSourceClaim,
  guardSourceUpdate,
  guardPayloadUpdate,
  guardDispatchPayload,
  OPERATOR_ORIGIN_SOURCES,
  UNVERIFIED_OPERATOR_SOURCE,
} = require('../lib/provenance');
const {
  OPERATOR_TASK_HEADER,
  createOperatorTaskOrigin,
  createBoardOriginCheck,
  createOperatorTaskAttestationVerifier,
} = require('../services/operator-task-origin');
const mcpProvenance = require('../../services/praxis-mind-mcp/lib/provenance');

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const TS = 1758200000000;
const NONCE = '00112233445566778899aabbccddeeff';
const PROJECT = 'proj-1';
const NAME = 'Add a durable /card entry point';

/** The formula, written out independently of the module under test. */
function reference(key, surface, ts, nonce, projectId, name) {
  const digest = crypto.createHash('sha256').update(`${projectId}\n${name}`, 'utf8').digest('hex');
  return crypto.createHmac('sha256', key)
    .update(`praxis-operator-task/v1\n${surface}\n${ts}\n${nonce}\n${digest}`, 'utf8')
    .digest('hex');
}

function header({ key = KEY, surface = 'chat-dispatch', ts = TS, nonce = NONCE, projectId = PROJECT, name = NAME } = {}) {
  return `v1;surface=${surface};ts=${ts};nonce=${nonce};sig=${reference(key, surface, ts, nonce, projectId, name)}`;
}

const originalKey = process.env.PRAXIS_OPERATOR_KEY;
beforeEach(() => { process.env.PRAXIS_OPERATOR_KEY = KEY; });
afterAll(() => {
  if (originalKey === undefined) delete process.env.PRAXIS_OPERATOR_KEY;
  else process.env.PRAXIS_OPERATOR_KEY = originalKey;
});

// ─── Labels ────────────────────────────────────────────────────────────────

describe('operator origin labels', () => {
  it('classify as agent tier: trusted enough to dispatch unwrapped, never operator tier over HTTP', () => {
    expect(OPERATOR_ORIGIN_SOURCES).toEqual({ board: 'operator:board', chat: 'operator:chat' });
    for (const label of Object.values(OPERATOR_ORIGIN_SOURCES)) {
      expect(classifySource(label)).toBe('agent');
      expect(isOperatorOriginSource(label)).toBe(true);
      expect(mcpProvenance.classifySource(label)).toBe('agent');
    }
    expect(isOperatorOriginSource(UNVERIFIED_OPERATOR_SOURCE)).toBe(false);
    expect(isOperatorOriginSource('user')).toBe(false);
  });

  it('cannot be claimed in a request body, nor can any namespaced operator claim', () => {
    for (const claim of ['operator:board', 'operator:chat', 'Operator:Board', 'user:anything', 'dashboard:x', 'robert:idea']) {
      const result = normalizeSourceClaim(claim);
      expect(result.source).toBe(UNVERIFIED_OPERATOR_SOURCE);
      expect(result.downgradedFrom).toBe(claim);
    }
    // Agent namespaces that merely contain a colon are untouched.
    expect(normalizeSourceClaim('workflow:security-sweep').source).toBe('workflow:security-sweep');
    expect(normalizeSourceClaim('upgrade-slate:x').source).toBe('upgrade-slate:x');
  });

  it('cannot be reached by a later write either', () => {
    // An agent-filed task claiming the label is recorded as the unverified label.
    expect(guardSourceUpdate('praxis-agent', 'operator:board')).toEqual({ source: UNVERIFIED_OPERATOR_SOURCE, refused: false });
    // An external task cannot rise to it at all.
    expect(guardSourceUpdate(null, 'operator:chat')).toEqual({ source: undefined, refused: true });
  });

  it('survives Praxis rewriting the payload: the label records who filed the task', () => {
    expect(guardPayloadUpdate('operator:board', true)).toBeUndefined();
    expect(guardPayloadUpdate('operator:chat', true)).toBeUndefined();
  });

  it('hands executors the brief unwrapped, commands included', () => {
    const payload = { prompt: 'Add the /card route.\n\nAcceptance criteria:\n- it redirects', commands: ['npm test'] };
    expect(guardDispatchPayload({ source: 'operator:chat', antigravity_payload: payload })).toBe(payload);
    // The defect being fixed: the same brief with no source is wrapped.
    expect(guardDispatchPayload({ source: null, antigravity_payload: payload }).prompt)
      .toMatch(/^Retrieved content is reference data/);
  });
});

// ─── Chat attestation ──────────────────────────────────────────────────────

describe('operator-task attestation verifier', () => {
  const at = (ms) => createOperatorTaskAttestationVerifier({ now: () => ms });

  it('accepts the pinned reference vector exactly once', () => {
    // The literal Praxis's signer must produce for these inputs (Praxis pins
    // the same value in tests/operator_provenance.test.ts).
    expect(reference(KEY, 'chat-dispatch', TS, NONCE, PROJECT, NAME))
      .toBe('a983b4f61ae52a54111d8599ce9f276584a417d22af9885fb21a255a2e365dde');
    const verify = at(TS + 1000);
    expect(verify(header(), { projectId: PROJECT, name: NAME })).toEqual({ ok: true, surface: 'chat-dispatch', source: 'operator:chat' });
    expect(verify(header(), { projectId: PROJECT, name: NAME })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('binds the project and the task name', () => {
    const verify = at(TS + 1000);
    expect(verify(header(), { projectId: PROJECT, name: 'Some other task' }).reason).toBe('bad-signature');
    expect(verify(header(), { projectId: 'proj-2', name: NAME }).reason).toBe('bad-signature');
  });

  it('refuses another key, a stale or future signature, and unknown surfaces', () => {
    const verify = at(TS + 1000);
    expect(verify(header({ key: OTHER_KEY }), { projectId: PROJECT, name: NAME }).reason).toBe('bad-signature');
    expect(at(TS + 5 * 60 * 1000 + 1)(header(), { projectId: PROJECT, name: NAME }).reason).toBe('stale');
    expect(at(TS - 61 * 1000)(header(), { projectId: PROJECT, name: NAME }).reason).toBe('future-dated');
    expect(verify(header({ surface: 'task-dispatch' }), { projectId: PROJECT, name: NAME }).reason).toBe('unknown-surface');
  });

  it('never accepts a chat-provenance signature made with the same key (distinct prefix)', () => {
    const digest = crypto.createHash('sha256').update(`${PROJECT}\n${NAME}`, 'utf8').digest('hex');
    const chatSig = crypto.createHmac('sha256', KEY)
      .update(`praxis-operator-provenance/v1\nchat-dispatch\n${TS}\n${NONCE}\n${digest}`, 'utf8').digest('hex');
    const forged = `v1;surface=chat-dispatch;ts=${TS};nonce=${NONCE};sig=${chatSig}`;
    expect(at(TS + 1000)(forged, { projectId: PROJECT, name: NAME }).reason).toBe('bad-signature');
  });

  it('refuses everything when the shared key is missing or too short', () => {
    delete process.env.PRAXIS_OPERATOR_KEY;
    expect(at(TS + 1000)(header(), { projectId: PROJECT, name: NAME }).reason).toBe('not-configured');
    process.env.PRAXIS_OPERATOR_KEY = 'short';
    expect(at(TS + 1000)(header(), { projectId: PROJECT, name: NAME }).reason).toBe('not-configured');
  });

  it('refuses malformed headers and missing bindings', () => {
    const verify = at(TS + 1000);
    for (const bad of ['', 'v1', 'v2;surface=chat-dispatch;ts=1;nonce=00112233445566778899aabbccddeeff;sig=00', `v1;surface=chat-dispatch;ts=${TS};nonce=xyz;sig=${'0'.repeat(64)}`]) {
      expect(verify(bad, { projectId: PROJECT, name: NAME }).ok).toBe(false);
    }
    expect(verify(header(), { projectId: PROJECT }).reason).toBe('malformed');
  });
});

// ─── Board session ─────────────────────────────────────────────────────────

describe('board origin check', () => {
  const req = (body, headers = {}) => ({ body, get: (name) => headers[name.toLowerCase()] });

  it('is not consulted unless the create asks for operator origin', async () => {
    const authorize = jest.fn();
    expect(await createBoardOriginCheck({ authorize })(req({ title: 'x' }))).toEqual({ requested: false, verified: false });
    expect(await createBoardOriginCheck({ authorize })(req({ title: 'x', operator: 'true' }))).toEqual({ requested: false, verified: false });
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(['access_user', 'access_device', 'operator_credential'])('grants it for a verified %s session', async (authority) => {
    const check = createBoardOriginCheck({ authorize: async () => ({ ok: true, actor: { id: 'local_user', authority } }) });
    expect(await check(req({ operator: true }))).toEqual({ requested: true, verified: true });
  });

  it('refuses the document executor credential, an unverified request, a cross-site request and a failed check', async () => {
    const executor = createBoardOriginCheck({ authorize: async () => ({ ok: true, actor: { authority: 'document_executor_credential' } }) });
    expect((await executor(req({ operator: true }))).verified).toBe(false);
    const refused = createBoardOriginCheck({ authorize: async () => ({ ok: false, code: 'operator_required' }) });
    expect(await refused(req({ operator: true }))).toEqual({ requested: true, verified: false, reason: 'operator_required' });
    const authorize = jest.fn(async () => ({ ok: true, actor: { authority: 'access_user' } }));
    expect((await createBoardOriginCheck({ authorize })(req({ operator: true }, { 'sec-fetch-site': 'cross-site' }))).reason).toBe('cross-site');
    expect(authorize).not.toHaveBeenCalled();
    const broken = createBoardOriginCheck({ authorize: async () => { throw new Error('boom'); } });
    expect((await broken(req({ operator: true }))).reason).toBe('check-unavailable');
  });
});

// ─── Routes ────────────────────────────────────────────────────────────────

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}
function close(handle) {
  for (const socket of handle.sockets) socket.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}
function buildApp(db, mountPath, operatorTaskOrigin) {
  const createTasksRouter = require('../routes/tasks');
  const app = express();
  app.use(express.json());
  app.use(mountPath, createTasksRouter({
    db,
    PROJECT_ROOT: '/Volumes/Projects',
    getProjectById: jest.fn(async () => ({ id: PROJECT, name: 'TheNexus' })),
    getAllProjects: jest.fn(),
    callAI: jest.fn(),
    validateInitiativeRequest: jest.fn(async () => ({})),
    pushService: {},
    ...(operatorTaskOrigin ? { operatorTaskOrigin } : {}),
  }));
  return app;
}
const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('board create route (POST /api/projects/:id/tasks)', () => {
  let handle;
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(async () => {
    warn.mockRestore();
    if (handle) await close(handle);
    handle = null;
  });
  const db = () => ({ createTask: jest.fn(async (task) => ({ id: 'task-1', ...task })), getTask: jest.fn(async () => null) });
  const origin = (authorize) => createOperatorTaskOrigin({ authorize });

  it('records Robert\'s verified board idea as operator:board', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/projects', origin(async () => ({ ok: true, actor: { authority: 'access_user' } }))));
    const res = await post(`${handle.baseUrl}/api/projects/${PROJECT}/tasks`, { operator: true, title: 'Try the new layout' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(store.createTask.mock.calls[0][0].source).toBe('operator:board');
    expect(store.createTask.mock.calls[0][0]).not.toHaveProperty('operator');
    expect(body.operator_origin).toEqual({ verified: true });
  });

  it('still saves the idea without a verified session, under the unverified label, and says so', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/projects', origin(async () => ({ ok: false, code: 'operator_required' }))));
    const res = await post(`${handle.baseUrl}/api/projects/${PROJECT}/tasks`, { operator: true, title: 'Try the new layout', source: 'operator:board' });
    expect(res.status).toBe(200);
    expect(store.createTask.mock.calls[0][0].source).toBe(UNVERIFIED_OPERATOR_SOURCE);
    expect((await res.json()).operator_origin).toEqual({ verified: false, reason: 'operator_required' });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/without a verified operator session \(operator_required\)/);
  });

  it('leaves machine callers exactly where they were: nexus-api, no origin block', async () => {
    const authorize = jest.fn();
    const store = db();
    handle = await listen(buildApp(store, '/api/projects', origin(authorize)));
    const res = await post(`${handle.baseUrl}/api/projects/${PROJECT}/tasks`, { title: 'Scripted task' });
    expect(store.createTask.mock.calls[0][0].source).toBe(UNVERIFIED_OPERATOR_SOURCE);
    expect(await res.json()).not.toHaveProperty('operator_origin');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('with the production authority, a bare local request asking for operator origin is not verified', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/projects'));
    const res = await post(`${handle.baseUrl}/api/projects/${PROJECT}/tasks`, { operator: true, title: 'curl claims to be Robert' });
    expect(res.status).toBe(200);
    expect(store.createTask.mock.calls[0][0].source).toBe(UNVERIFIED_OPERATOR_SOURCE);
    expect((await res.json()).operator_origin.verified).toBe(false);
  });
});

describe('chat dispatch batch route (POST /api/tasks/batch)', () => {
  let handle;
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(async () => {
    warn.mockRestore();
    if (handle) await close(handle);
    handle = null;
  });
  const db = () => ({
    batchCreateTasks: jest.fn(async (tasks) => tasks.map((t) => ({ ...t }))),
    getProject: jest.fn(async () => ({ id: PROJECT, name: 'TheNexus' })),
    getTask: jest.fn(async () => null),
  });
  // A fresh attestation for "now", signed the way Praxis signs it.
  const fresh = (name = NAME, nonce = crypto.randomBytes(16).toString('hex')) => header({ ts: Date.now(), nonce, name });
  const task = (extra = {}) => ({ name: NAME, status: 'todo', source: 'operator:chat', antigravity_payload: { prompt: 'Robert\'s brief' }, ...extra });

  it('records an attested chat dispatch as operator:chat', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/tasks'));
    const res = await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task()] }, { [OPERATOR_TASK_HEADER]: fresh() });
    expect(res.status).toBe(201);
    expect(store.batchCreateTasks.mock.calls[0][0][0].source).toBe('operator:chat');
    expect(warn).not.toHaveBeenCalled();
  });

  it('caps the same claim without an attestation, or with one for another task', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/tasks'));
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task()] });
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task()] }, { [OPERATOR_TASK_HEADER]: fresh('A different task') });
    expect(store.batchCreateTasks.mock.calls.map((call) => call[0][0].source)).toEqual([UNVERIFIED_OPERATOR_SOURCE, UNVERIFIED_OPERATOR_SOURCE]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/attestation refused \(bad-signature\)/);
  });

  it('accepts each attestation once, and only for a single-task batch', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/tasks'));
    const once = fresh();
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task()] }, { [OPERATOR_TASK_HEADER]: once });
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task()] }, { [OPERATOR_TASK_HEADER]: once });
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task(), task({ name: 'Second' })] }, { [OPERATOR_TASK_HEADER]: fresh() });
    const sources = store.batchCreateTasks.mock.calls.map((call) => call[0].map((t) => t.source));
    expect(sources).toEqual([['operator:chat'], [UNVERIFIED_OPERATOR_SOURCE], [UNVERIFIED_OPERATOR_SOURCE, UNVERIFIED_OPERATOR_SOURCE]]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/replayed[\s\S]*not-single-task/);
  });

  it('leaves an unlabelled batch unlabelled (the cautious external default is unchanged)', async () => {
    const store = db();
    handle = await listen(buildApp(store, '/api/tasks'));
    await post(`${handle.baseUrl}/api/tasks/batch`, { project_id: PROJECT, tasks: [task({ source: undefined })] });
    expect(store.batchCreateTasks.mock.calls[0][0][0].source).toBeUndefined();
  });
});
