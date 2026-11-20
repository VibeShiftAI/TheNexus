/**
 * Option A (Robert, 2026-11-20, task 5e513530): a send or a document decision
 * made through the local operator session records nothing until Robert answers
 * a native macOS dialog naming that exact action. The OS peer check is a
 * fixture (as in local-operator-flows.test.js); the dialog is a scripted
 * stand-in that records what it was asked to show. The real osascript runner
 * is covered with an injected exec; the real dialog is exercised by
 * scripts/operator-confirmation-qa/live-check.cjs. Synthetic data only.
 */
const mockPeer = { device: 'mac-chrome' };
jest.mock('../services/local-operator-peer', () => ({
    ...jest.requireActual('../services/local-operator-peer'),
    createLocalOperatorPeerVerifier: () => async () => mockPeer.device,
}));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const confirmation = require('../services/operator-confirmation');
const access = require('./helpers/operator-access');

const KEY = 'synthetic-operator-'.repeat(4);
const RUNTIME_KEY = 'synthetic-runtime-'.repeat(4);
const RELAY_KEY = 'synthetic-relay-'.repeat(4);
const ORIGIN = 'http://localhost:3000';
const nativeFetch = global.fetch;
const envelope = { to: 'member@example.test', cc: ['copy@example.test'], subject: 'Review invitation', text: 'Exact body.\nSecond line.', attachments: [] };
const provenance = { member_id: 'member-1', project_id: 'project-1', task_id: 'task-1', source_refs: ['synthetic:source-1'] };
let server, base, raw, root, file, store, doc, revision, originalEnv, restoreAccess;
let prompts, answers, logs, drafts, relayed;
const clientProofs = new Map();

async function api(method, url, body, headers = {}, signal) {
    const response = await nativeFetch(base + url, {
        method, signal,
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...(headers.cookie && clientProofs.has(headers.cookie) ? { 'x-nexus-local-proof': clientProofs.get(headers.cookie) } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function bootstrap() {
    const result = await api('POST', '/api/operator-session/bootstrap', undefined);
    expect(result.status).toBe(201);
    clientProofs.set(result.cookie, result.json.proof);
    return result.cookie;
}
const decide = (cookie, body = {}, headers = {}, signal) => api('POST', `/api/documents/${doc.id}/decisions`, { revision_id: revision.id, decision: 'approve', ...body }, { cookie, ...headers }, signal);
const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };

beforeEach(async () => {
    originalEnv = { ...process.env };
    mockPeer.device = 'mac-chrome';
    Object.assign(process.env, {
        NEXUS_LOCAL_OPERATOR_SESSIONS: '1', NEXUS_LOCAL_OPERATOR_UID: '501', NEXUS_LOCAL_OPERATOR_CHROME: '1',
        NEXUS_OPERATOR_APPROVAL_KEY: KEY, NEXUS_DOCUMENT_APPROVAL_KEY: 'synthetic-executor-'.repeat(4),
        NEXUS_STAKEHOLDER_RUNTIME_KEY: RUNTIME_KEY, PRAXIS_OPERATOR_KEY: RELAY_KEY,
    });
    restoreAccess = access.configure();
    global.fetch = async (url, options) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks } : nativeFetch(url, options));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-operator-confirmation-')));
    file = path.join(root, 'fixture.md');
    fs.writeFileSync(file, '# Synthetic review\n', 'utf8');
    raw = new Database(':memory:'); initializeDocumentReviews(raw); store = createDocumentReviewStore(raw);
    const project = { id: 'project-1', name: 'Synthetic', path: root };
    const task = { id: 'task-1', project_id: project.id, name: 'Synthetic review' };
    const db = { documentReviews: store, getProjects: async () => [project], getProject: async id => id === project.id ? project : null, getTask: async id => id === task.id ? task : null };
    prompts = []; answers = []; logs = []; relayed = [];
    drafts = new Map([['md_fixture', { id: 'md_fixture', version: 'v1', status: 'draft', to: 'member@example.test', cc: ['copy@example.test'], subject: 'Quarterly update [md1]', body: 'Hello member,\nExact body.' }]]);
    const confirmations = confirmation.createOperatorConfirmations({
        show: async prompt => { prompts.push(prompt); const next = answers.length ? answers.shift() : 'confirmed'; return typeof next === 'function' ? next(prompt) : next; },
        log: { log: line => logs.push(line) },
    });
    const app = express(); app.use(express.json());
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    vm.runInNewContext(source.slice(source.indexOf('function authenticate(req, res, next)'), source.indexOf("app.use('/api/write-leases'")), { app });
    app.use('/api/operator-session', require('../routes/operator-session')());
    app.use('/api/documents', require('../routes/documents')({ db, confirmations }));
    app.use('/api/praxis/mailbox/drafts-review', require('../routes/mail-draft-review')({
        confirmations,
        // Praxis stand-in: lists drafts, checks the body-bound relay proof and the version.
        relay: async (url, options) => {
            if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ items: [...drafts.values()].filter(d => !['sent', 'cancelled'].includes(d.status)) }) };
            const parts = Object.fromEntries(options.headers['X-Praxis-Operator-Provenance'].split(';').slice(1).map(v => v.split('=')));
            const digest = crypto.createHash('sha256').update(JSON.stringify({ purpose: 'mail-draft-review', id: url.split('/').pop(), body: options.body }), 'utf8').digest('hex');
            expect(parts.sig).toBe(crypto.createHmac('sha256', RELAY_KEY).update(`praxis-operator-provenance/v1\n${parts.surface}\n${parts.ts}\n${parts.nonce}\n${digest}`, 'utf8').digest('hex'));
            const draft = drafts.get(url.split('/').pop());
            relayed.push(options.body);
            if (!draft || draft.version !== options.body.version) return { ok: false, status: 409, json: async () => ({ error: 'Draft changed; reload the current version' }) };
            if (options.body.action === 'approve_send') Object.assign(draft, { status: 'sent', version: 'v-sent' });
            if (options.body.action === 'edit') Object.assign(draft, { subject: options.body.subject, body: options.body.body, version: `v-${relayed.length}` });
            return { ok: true, status: 200, json: async () => ({ draft }) };
        },
    }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const registration = await api('POST', '/api/documents', { path: file, title: 'Synthetic brief', project_id: project.id, task_id: task.id, deliverable: { key: 'fixture', requires_review: true, intended_action: 'none' } });
    expect(registration.status).toBe(201); doc = registration.json.document; revision = registration.json.revision;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close(); fs.rmSync(root, { recursive: true, force: true });
    global.fetch = nativeFetch; restoreAccess(); process.env = originalEnv;
});

describe('confirmation broker', () => {
    const action = (identity = { kind: 'document_decision', document_id: 'd1', revision_id: 'r1' }) => confirmation.documentDecisionAction({
        identity, title: 'Brief', revision: { id: 'r1', content_hash: 'a'.repeat(64), captured_at: '2026-11-20T14:00:00Z' }, version: 2, decision: 'approve', note: '',
    });
    const res = () => Object.assign(new EventEmitter(), { writableEnded: false });

    test('Access, operator-bearer and executor-bearer paths are never asked; a result that does not say its path is refused', async () => {
        const show = jest.fn(async () => 'confirmed');
        const broker = confirmation.createOperatorConfirmations({ show, log: {} });
        for (const via of ['access_session', 'operator_bearer', 'document_executor_bearer']) {
            const result = await broker.confirm({ res: res(), auth: { via }, action: action() });
            expect(result).toMatchObject({ ok: true, required: false });
            expect(result.consume({ anything: true })).toBe(true);
        }
        expect(show).not.toHaveBeenCalled();
        expect(await broker.confirm({ res: res(), auth: { ok: true, actor: { authority: 'operator_credential' } }, action: action() }))
            .toMatchObject({ ok: false, status: 503, code: 'operator_confirmation_unavailable', nothing_recorded: true });
        expect(show).not.toHaveBeenCalled();
        expect(await broker.confirm({ res: res(), auth: { via: 'local_session', device: 'mac-chrome' }, action: action() })).toMatchObject({ ok: true, required: true });
        expect(show).toHaveBeenCalledTimes(1);
    });

    test('a confirmation is single use, bound to the confirmed identity and to a short window', async () => {
        let clock = 1_000_000;
        const broker = confirmation.createOperatorConfirmations({ show: async () => 'confirmed', now: () => clock, log: {} });
        const identity = { kind: 'mail_send', draft_id: 'md_1', version: 'v1', to: 'a@example.test' };
        const ask = () => broker.confirm({ res: res(), auth: { via: 'local_session' }, action: confirmation.mailSendAction({ identity, to: 'a@example.test', cc: [], subject: 'S', body: 'B' }) });
        const first = await ask();
        expect(first.consume({ ...identity, to: 'attacker@example.test' })).toBe(false);
        expect(first.consume(identity)).toBe(false); // used up by the mismatch: a retry asks again
        const second = await ask();
        // Key order does not matter; values do.
        expect(second.consume({ to: 'a@example.test', version: 'v1', draft_id: 'md_1', kind: 'mail_send' })).toBe(true);
        expect(second.consume(identity)).toBe(false);
        const third = await ask();
        clock += 61_000;
        expect(third.consume(identity)).toBe(false);
    });

    test('one dialog at a time, and three unanswered dialogs pause asking for five minutes', async () => {
        let clock = 5_000_000;
        let release;
        const show = jest.fn(() => new Promise(resolve => { release = resolve; }));
        const broker = confirmation.createOperatorConfirmations({ show, now: () => clock, log: {} });
        const auth = { via: 'local_session' };
        const pending = broker.confirm({ res: res(), auth, action: action() });
        await waitFor(() => show.mock.calls.length === 1);
        expect(await broker.confirm({ res: res(), auth, action: action() })).toMatchObject({ ok: false, status: 409, code: 'operator_confirmation_busy' });
        release('declined');
        expect(await pending).toMatchObject({ code: 'operator_confirmation_declined' });
        for (const outcome of ['timeout', 'declined']) {
            const next = broker.confirm({ res: res(), auth, action: action() });
            await waitFor(() => release && show.mock.calls.length >= 2);
            release(outcome);
            await next;
        }
        expect(show).toHaveBeenCalledTimes(3);
        // Deliberate declines count too (unwanted prompts are declined), and the reason says so.
        expect(await broker.confirm({ res: res(), auth, action: action() })).toMatchObject({ ok: false, status: 429, code: 'operator_confirmation_paused',
            error: 'Confirmations on this Mac are paused for five minutes after three were declined, left unanswered or abandoned within ten minutes. Nothing was recorded.' });
        expect(show).toHaveBeenCalledTimes(3);
        clock += 5 * 60 * 1000 + 1;
        const after = broker.confirm({ res: res(), auth, action: action() });
        await waitFor(() => show.mock.calls.length === 4);
        release('confirmed');
        expect(await after).toMatchObject({ ok: true, required: true });
    });

    test('a client that goes away closes the dialog and is refused as aborted', async () => {
        const show = jest.fn(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve('aborted'))));
        const broker = confirmation.createOperatorConfirmations({ show, log: {} });
        const response = res();
        const pending = broker.confirm({ res: response, auth: { via: 'local_session' }, action: action() });
        await waitFor(() => show.mock.calls.length === 1);
        response.emit('close');
        expect(await pending).toMatchObject({ ok: false, code: 'operator_confirmation_aborted', nothing_recorded: true });
    });

    test('a client that left before the dialog would open is refused as aborted without asking, and that does not count toward the pause', async () => {
        const show = jest.fn(async () => 'confirmed');
        const broker = confirmation.createOperatorConfirmations({ show, log: {} });
        const auth = { via: 'local_session' };
        // What Node reports once the client has gone: the response or its socket is destroyed.
        for (const gone of [{ destroyed: true }, { socket: { destroyed: true } }, { destroyed: true }]) {
            expect(await broker.confirm({ res: Object.assign(res(), gone), auth, action: action() }))
                .toMatchObject({ ok: false, status: 409, code: 'operator_confirmation_aborted', nothing_recorded: true });
        }
        expect(show).not.toHaveBeenCalled();
        expect(await broker.confirm({ res: res(), auth, action: action() })).toMatchObject({ ok: true, required: true });
        expect(show).toHaveBeenCalledTimes(1);
    });

    test('a failing or unexpected dialog answer is unavailable, never a fallback', async () => {
        for (const show of [async () => { throw new Error('osascript missing'); }, async () => 'yes', async () => undefined]) {
            const broker = confirmation.createOperatorConfirmations({ show, log: {} });
            expect(await broker.confirm({ res: res(), auth: { via: 'local_session' }, action: action() }))
                .toMatchObject({ ok: false, status: 503, code: 'operator_confirmation_unavailable', nothing_recorded: true });
        }
    });

    test('dialog text names the action from server values, removes invisible characters and says how much of a long body it shows', async () => {
        const show = jest.fn(async () => 'declined');
        const broker = confirmation.createOperatorConfirmations({ show, log: {}, now: () => Date.UTC(2026, 10, 20, 19, 0, 0) });
        const subject = `Invoice ${String.fromCodePoint(0x202e)}fdp.exe${String.fromCodePoint(0x200b)}`;
        await broker.confirm({ res: res(), auth: { via: 'local_session', device: 'mac-desktop' }, action: confirmation.mailSendAction({
            identity: { kind: 'mail_send' }, to: 'member@example.test', cc: ['copy@example.test', 'second@example.test'], subject, body: 'b'.repeat(1000),
        }) });
        const prompt = show.mock.calls[0][0];
        expect(prompt).toMatchObject({ title: 'Nexus: send this email?', confirmLabel: 'Send', seconds: 120 });
        const lines = prompt.message.split('\n');
        expect(lines[0]).toBe('Send to member@example.test: "Invoice fdp.exe"?');
        expect(lines[1]).toBe('Cc: copy@example.test, second@example.test');
        expect(prompt.message).toContain('Message (first 800 of 1000 characters; the rest is in Nexus):');
        expect(prompt.message).toMatch(/ \[\.\.\.\]\n\nRequested by The Nexus app on localhost:3000 at \d{2}:\d{2}:\d{2}\.\nIf you did not just ask for this in Nexus, click Cancel\.\nRef [0-9a-f]{8}$/);
        expect([...prompt.message].some(char => [0x202e, 0x200b].includes(char.codePointAt(0)))).toBe(false);
    });

    test('a request too long for the dialog keeps who asked, the warning and the Ref, and says exactly how much it leaves out', async () => {
        const show = jest.fn(async () => 'declined');
        const broker = confirmation.createOperatorConfirmations({ show, log: {} });
        const answers = Array.from({ length: 30 }, (_, i) => ({ question: `Question ${i} ${'q'.repeat(140)}`, label: `Answer ${i} ${'a'.repeat(180)}` }));
        const finish = confirmation.reviewFinishAction({
            identity: { kind: 'review_finish' }, title: 'Brief', revisionId: 'r1', version: 2, delegated: false, answers, summary: 's'.repeat(400), commentCount: 3,
        });
        await broker.confirm({ res: res(), auth: { via: 'local_session', device: 'mac-chrome' }, action: finish });
        const { message } = show.mock.calls[0][0];
        const full = finish.lines.filter(line => line !== null && line !== undefined).join('\n');
        expect(full.length).toBeGreaterThan(4000);
        expect(message.length).toBeLessThanOrEqual(4000);
        const [note, count] = message.match(/\n\[(\d+) more characters of this request are not shown here; Nexus shows all of it\]/);
        const shown = message.slice(0, message.indexOf(note));
        expect(full.startsWith(shown)).toBe(true);
        expect(shown.length + Number(count)).toBe(full.length);
        expect(shown).toContain('Decision answers (30):');
        expect(message.slice(message.indexOf(note) + note.length)).toMatch(/^\n\nRequested by Google Chrome on localhost:3000 at \d{2}:\d{2}:\d{2}\.\nIf you did not just ask for this in Nexus, click Cancel\.\nRef [0-9a-f]{8}$/);
    });

    test('the osascript runner passes every server string as argv, defaults to Cancel and maps each outcome', async () => {
        const calls = [];
        const runner = (result) => (file, args, options, callback) => { calls.push({ file, args, options }); setImmediate(() => callback(...result)); };
        const prompt = { title: 'Nexus: send this email?', message: 'Send to "x" & `y`; $(rm -rf /)', confirmLabel: 'Send', seconds: 7 };
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([null, 'confirmed\n']), platform: 'darwin' })).toBe('confirmed');
        const [{ file: binary, args, options }] = calls;
        expect(binary).toBe('/usr/bin/osascript');
        expect(args.slice(-4)).toEqual([prompt.title, prompt.message, 'Send', '7']);
        const script = args.slice(0, -4).filter((_, index) => index % 2 === 1).join('\n');
        expect(args.slice(0, -4).filter((_, index) => index % 2 === 0).every(flag => flag === '-e')).toBe(true);
        expect(script).toContain('default button "Cancel" cancel button "Cancel"');
        expect(script).toContain('giving up after waitSeconds');
        expect(script).not.toContain(prompt.message);
        expect(options).toMatchObject({ timeout: 22_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([null, 'declined\n']), platform: 'darwin' })).toBe('declined');
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([null, 'timeout\n']), platform: 'darwin' })).toBe('timeout');
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([Object.assign(new Error('killed'), { killed: true }), '']), platform: 'darwin' })).toBe('timeout');
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([new Error('No user interaction allowed. (-1713)'), '']), platform: 'darwin' })).toBe('unavailable');
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([null, 'Send\n']), platform: 'darwin' })).toBe('unavailable');
        const before = calls.length;
        expect(await confirmation.showMacDialog({ ...prompt, run: runner([null, 'confirmed\n']), platform: 'linux' })).toBe('unavailable');
        expect(calls).toHaveLength(before);
        const controller = new AbortController(); controller.abort();
        expect(await confirmation.showMacDialog({ ...prompt, signal: controller.signal, run: runner([Object.assign(new Error('aborted'), { name: 'AbortError' }), '']), platform: 'darwin' })).toBe('aborted');
    });
});

describe('document decisions through the local session', () => {
    test('the stored session proof alone records nothing: declined, timed out and unavailable dialogs refuse, and forged confirmation fields are ignored', async () => {
        const cookie = await bootstrap();
        const cases = [['declined', 403, 'operator_confirmation_declined'], ['timeout', 403, 'operator_confirmation_timeout'], ['unavailable', 503, 'operator_confirmation_unavailable']];
        for (const [outcome, status, code] of cases) {
            answers.push(outcome);
            const result = await decide(cookie, { confirmation: 'confirmed', confirmed: true, confirmation_ref: 'deadbeef' }, { 'x-nexus-operator-confirmation': 'confirmed' });
            expect(result.status).toBe(status);
            expect(result.json).toMatchObject({ code, nothing_recorded: true });
        }
        expect(prompts).toHaveLength(3);
        expect(store.listDecisions(doc.id)).toHaveLength(0);
        // An unavailable dialog is no sign of prompt fatigue; a third unanswered one
        // (declined, timeout, declined) pauses asking, without falling back.
        answers.push('declined');
        expect((await decide(cookie)).json.code).toBe('operator_confirmation_declined');
        const paused = await decide(cookie);
        expect(paused.status).toBe(429); expect(paused.json).toMatchObject({ code: 'operator_confirmation_paused', nothing_recorded: true });
        expect(prompts).toHaveLength(4);
        expect(store.listDecisions(doc.id)).toHaveLength(0);
    });

    test('a confirmed decision records exactly once with the confirmed identity; repeating the request asks again', async () => {
        const cookie = await bootstrap();
        const result = await decide(cookie, { decision: 'request_changes', note: 'Tighten the second section.' });
        expect(result.status).toBe(201);
        expect(result.json.decision).toMatchObject({ decision: 'request_changes', revision_id: revision.id, content_hash: revision.content_hash, note: 'Tighten the second section.', authority: 'operator_credential', recorded_by: 'operator' });
        const [prompt] = prompts;
        expect(prompt).toMatchObject({ title: 'Nexus: request changes?', confirmLabel: 'Request changes' });
        expect(prompt.message).toContain('Request changes to "Synthetic brief"?');
        expect(prompt.message).toContain(`revision ${revision.id}, content sha256 ${revision.content_hash.slice(0, 12)}`);
        expect(prompt.message).toContain('Note:\nTighten the second section.');
        expect(prompt.message).toContain(`Ref ${result.json.confirmation_ref}`);
        expect(logs.some(line => line === `[OperatorConfirmation] confirmed document_decision ref=${result.json.confirmation_ref} device=mac-chrome`)).toBe(true);
        // The same request again is a new action: it asks again, and a decline records nothing.
        answers.push('declined');
        const again = await decide(cookie, { decision: 'request_changes', note: 'Tighten the second section.' });
        expect(again.status).toBe(403); expect(prompts).toHaveLength(2);
        expect(store.listDecisions(doc.id)).toHaveLength(1);
    });

    test('an idempotent retry of a confirmed decision answers from the record without asking or recording again', async () => {
        const cookie = await bootstrap();
        const first = await decide(cookie, { client_decision_id: 'click-1' });
        expect(first.status).toBe(201);
        const retry = await decide(cookie, { client_decision_id: 'click-1' });
        expect(retry.status).toBe(200); expect(retry.json).toMatchObject({ duplicate: true, decision: { id: first.json.decision.id } });
        expect(prompts).toHaveLength(1);
        expect(store.listDecisions(doc.id)).toHaveLength(1);
    });

    test('a document that changes on disk while the dialog is open is refused as stale; nothing is recorded', async () => {
        const cookie = await bootstrap();
        answers.push(() => { fs.writeFileSync(file, '# Synthetic review\n\nChanged while the dialog was open.\n', 'utf8'); return 'confirmed'; });
        const result = await decide(cookie);
        expect(result.status).toBe(409); expect(result.json.code).toBe('stale_revision');
        expect(store.listDecisions(doc.id)).toHaveLength(0);
    });

    test('a decision from the desktop app session is asked the same way (the webview path at the server boundary)', async () => {
        mockPeer.device = 'mac-desktop';
        const cookie = await bootstrap();
        answers.push('declined');
        expect((await decide(cookie)).status).toBe(403);
        expect(prompts[0].message).toContain('Requested by The Nexus app on localhost:3000');
        expect(store.listDecisions(doc.id)).toHaveLength(0);
        expect((await decide(cookie)).status).toBe(201);
        expect(store.listDecisions(doc.id)).toHaveLength(1);
    });

    test('while one dialog is open a second decision is refused as busy; only the confirmed one records', async () => {
        const cookie = await bootstrap();
        let release;
        answers.push(() => new Promise(resolve => { release = resolve; }));
        const first = decide(cookie);
        await waitFor(() => prompts.length === 1 && release);
        const second = await decide(cookie, { decision: 'request_changes' });
        expect(second.status).toBe(409); expect(second.json.code).toBe('operator_confirmation_busy');
        release('confirmed');
        expect((await first).status).toBe(201);
        expect(store.listDecisions(doc.id).map(d => d.decision)).toEqual(['approve']);
    });

    test('closing the request while the dialog is open closes it and records nothing', async () => {
        const cookie = await bootstrap();
        answers.push(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve('aborted'))));
        const controller = new AbortController();
        const pending = decide(cookie, {}, {}, controller.signal).catch(error => error.name);
        await waitFor(() => prompts.length === 1);
        controller.abort();
        expect(await pending).toBe('AbortError');
        await waitFor(() => logs.some(line => line.startsWith('[OperatorConfirmation] aborted document_decision')));
        expect(logs.some(line => line.startsWith('[OperatorConfirmation] aborted document_decision'))).toBe(true);
        expect(store.listDecisions(doc.id)).toHaveLength(0);
    });

    test('Access sessions and the operator bearer are separate credentials: never asked, recorded as before', async () => {
        const viaAccess = await decide(undefined, {}, { 'cf-access-jwt-assertion': access.token() });
        expect(viaAccess.status).toBe(201); expect(viaAccess.json.decision.authority).toBe('access_user');
        const viaBearer = await decide(undefined, { decision: 'request_changes' }, { authorization: `Bearer ${KEY}` });
        expect(viaBearer.status).toBe(201); expect(viaBearer.json.decision.authority).toBe('operator_credential');
        expect(prompts).toHaveLength(0);
    });
});

describe('finishing a review through the local session', () => {
    async function draftReview(cookie) {
        const opened = await api('POST', `/api/documents/${doc.id}/reviews`, { revision_id: revision.id }, { cookie });
        expect([200, 201]).toContain(opened.status);
        const review = opened.json.review;
        expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'Please shorten the intro.' }, { cookie })).status).toBe(201);
        return review;
    }

    test('a plain finish (feedback only) stays click-free', async () => {
        const cookie = await bootstrap();
        const review = await draftReview(cookie);
        const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Notes only.' }, { cookie });
        expect(finished.status).toBe(202); expect(prompts).toHaveLength(0);
    });

    test('the approve-after-changes grant asks once, names the grant, and is refused when a comment lands during the dialog', async () => {
        const cookie = await bootstrap();
        const review = await draftReview(cookie);
        answers.push(async () => {
            await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'Also approve whatever the executor adds.' }, { cookie });
            return 'confirmed';
        });
        const refused = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Approve after these changes.', approve_after_changes: true }, { cookie });
        expect(refused.status).toBe(409); expect(refused.json).toMatchObject({ code: 'operator_confirmation_mismatch', nothing_recorded: true });
        expect(store.getReview(review.id)).toMatchObject({ status: 'draft' });
        expect(store.getSubmissionForReview(review.id)).toBeFalsy();
        const [prompt] = prompts;
        expect(prompt).toMatchObject({ title: 'Nexus: finish this review?', confirmLabel: 'Approve after changes' });
        expect(prompt.message).toContain('Finish your review of "Synthetic brief"');
        expect(prompt.message).toContain('This lets the executor that applies your changes record your approval of the revised version.');
        expect(prompt.message).toContain('Comments in this review: 1.');
        // Asked again with the comment now visible in the count, it finishes once.
        const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Approve after these changes.', approve_after_changes: true }, { cookie });
        expect(finished.status).toBe(202);
        expect(finished.json.review).toMatchObject({ status: 'submitted', approval_delegated: true, submitted_authority: 'operator_credential' });
        expect(prompts[1].message).toContain('Comments in this review: 2.');
        const declinedReview = await draftReview(cookie);
        answers.push('declined');
        const declined = await api('POST', `/api/documents/reviews/${declinedReview.id}/finish`, { approve_after_changes: true }, { cookie });
        expect(declined.status).toBe(403); expect(store.getReview(declinedReview.id)).toMatchObject({ status: 'draft', approval_delegated: false });
    });
});

describe('sending email through the local session', () => {
    test('document outgoing: the stored proof alone is refused; a confirmed send approves exactly the reviewed envelope once', async () => {
        const outgoingDoc = path.join(root, 'outgoing.md');
        fs.writeFileSync(outgoingDoc, '# Outgoing draft\n', 'utf8');
        const registered = await api('POST', '/api/documents', { path: outgoingDoc, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1', deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } });
        const { document: target, revision: targetRevision } = registered.json;
        const prepared = await api('PUT', `/api/documents/${target.id}/outgoing`, { revision_id: targetRevision.id, envelope, provenance }, { authorization: `Bearer ${RUNTIME_KEY}` });
        expect(prepared.status).toBe(200);
        const outgoing = prepared.json.outgoing;
        const cookie = await bootstrap();
        const approve = () => api('POST', `/api/documents/${target.id}/outgoing/decision`, { decision: 'approve_send', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash }, { cookie });
        answers.push('declined');
        const declined = await approve();
        expect(declined.status).toBe(403); expect(declined.json).toMatchObject({ code: 'operator_confirmation_declined', nothing_recorded: true });
        expect(store.getOutgoing(target.id)).toMatchObject({ status: 'draft', grant: null });
        const approved = await approve();
        expect(approved.status).toBe(200);
        expect(approved.json.outgoing).toMatchObject({ status: 'approved', grant: { authority: 'operator_credential', envelope_hash: outgoing.envelope_hash, envelope } });
        expect(prompts[1].message.split('\n').slice(0, 2)).toEqual(['Send to member@example.test: "Review invitation"?', 'Cc: copy@example.test']);
        expect(prompts[1].message).toContain('Message:\nExact body.\nSecond line.');
        // A replay records nothing new and does not ask: the message is already approved.
        const replay = await approve();
        expect(replay.status).toBe(200); expect(replay.json.outgoing.grant.approved_at).toBe(approved.json.outgoing.grant.approved_at);
        expect(prompts).toHaveLength(2);
        expect(store.listOutgoingEvents(target.id).filter(event => event.event === 'approved')).toHaveLength(1);
    });

    test('document outgoing: an edit that lands while the dialog is open makes the confirmation unusable', async () => {
        const outgoingDoc = path.join(root, 'outgoing.md');
        fs.writeFileSync(outgoingDoc, '# Outgoing draft\n', 'utf8');
        const { document: target, revision: targetRevision } = (await api('POST', '/api/documents', { path: outgoingDoc, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1', deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } })).json;
        const outgoing = (await api('PUT', `/api/documents/${target.id}/outgoing`, { revision_id: targetRevision.id, envelope, provenance }, { authorization: `Bearer ${RUNTIME_KEY}` })).json.outgoing;
        const cookie = await bootstrap();
        answers.push(async () => {
            const edit = await api('POST', `/api/documents/${target.id}/outgoing/edit`, { revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash, subject: 'Review invitation', text: 'Different body added meanwhile.' }, { cookie });
            expect(edit.status).toBe(200);
            return 'confirmed';
        });
        const result = await api('POST', `/api/documents/${target.id}/outgoing/decision`, { decision: 'approve_send', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash }, { cookie });
        expect(result.status).toBe(409); expect(result.json).toMatchObject({ code: 'operator_confirmation_mismatch', nothing_recorded: true });
        expect(store.getOutgoing(target.id)).toMatchObject({ status: 'draft', grant: null });
    });

    test('document outgoing: a send the store would refuse is refused before asking', async () => {
        const outgoingDoc = path.join(root, 'outgoing.md');
        fs.writeFileSync(outgoingDoc, '# Outgoing draft\n', 'utf8');
        const { document: target, revision: targetRevision } = (await api('POST', '/api/documents', { path: outgoingDoc, title: 'Outgoing', project_id: 'project-1', task_id: 'task-1', deliverable: { key: 'synthetic-outgoing', purpose: 'Review invitation', requires_review: true, intended_action: 'send' } })).json;
        const outgoing = (await api('PUT', `/api/documents/${target.id}/outgoing`, { revision_id: targetRevision.id, envelope: { ...envelope, cc: [] }, provenance }, { authorization: `Bearer ${RUNTIME_KEY}` })).json.outgoing;
        const cookie = await bootstrap();
        const approve = row => api('POST', `/api/documents/${target.id}/outgoing/decision`, { decision: 'approve_send', revision_id: row.revision_id, envelope_hash: row.envelope_hash }, { cookie });
        const noCopy = await approve(outgoing);
        expect(noCopy.status).toBe(409); expect(noCopy.json.code).toBe('operator_copy_missing');
        // Returning the message to Praxis stays click-free; approving it before Praxis revises it is refused unasked.
        const returned = await api('POST', `/api/documents/${target.id}/outgoing/decision`, { decision: 'return_to_praxis', revision_id: outgoing.revision_id, envelope_hash: outgoing.envelope_hash, comments: 'Add the operator copy.' }, { cookie });
        expect(returned.status).toBe(200);
        const changes = await approve(returned.json.outgoing);
        expect(changes.status).toBe(409); expect(changes.json.code).toBe('changes_requested');
        expect(prompts).toHaveLength(0);
        expect(store.getOutgoing(target.id)).toMatchObject({ status: 'draft', grant: null });
        expect(store.listOutgoingEvents(target.id).filter(event => event.event === 'approved')).toHaveLength(0);
    });

    test('Praxis mail: a draft with an HTML part says so in the dialog', async () => {
        const cookie = await bootstrap();
        const send = () => api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action: 'approve_send', version: 'v1' }, { cookie });
        // A whitespace-only HTML part (Praxis rejects those) is no HTML part.
        drafts.get('md_fixture').html = ' \n\t ';
        answers.push('declined');
        expect((await send()).status).toBe(403);
        expect(prompts[0].message.split('\n').slice(0, 3)).toEqual(['Send to member@example.test: "Quarterly update [md1]"?', 'Cc: copy@example.test', '']);
        const html = '<p>Hello member,</p><p>Exact body.</p>';
        drafts.get('md_fixture').html = html;
        answers.push('declined');
        const declined = await send();
        expect(declined.status).toBe(403); expect(declined.json).toMatchObject({ code: 'operator_confirmation_declined', nothing_recorded: true });
        expect(prompts[1].message.split('\n').slice(0, 3)).toEqual([
            'Send to member@example.test: "Quarterly update [md1]"?', 'Cc: copy@example.test',
            `This email also has an HTML part (${html.length} characters). Most mail apps show that part instead of the text below; the draft in Nexus shows it.`,
        ]);
        expect(relayed).toEqual([]);
    });

    test('Praxis mail: the dialog names recipient and subject from Praxis; declined relays nothing; confirmed relays exactly the confirmed version once', async () => {
        const cookie = await bootstrap();
        const send = (body = {}) => api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action: 'approve_send', version: 'v1', ...body }, { cookie });
        answers.push('timeout');
        const timedOut = await send();
        expect(timedOut.status).toBe(403); expect(timedOut.json).toMatchObject({ code: 'operator_confirmation_timeout', nothing_recorded: true });
        expect(relayed).toEqual([]);
        expect(prompts[0].message.split('\n').slice(0, 2)).toEqual(['Send to member@example.test: "Quarterly update [md1]"?', 'Cc: copy@example.test']);
        // Extra client fields never reach Praxis with a confirmed send.
        const sent = await send({ subject: 'Client says otherwise', body: 'Injected', to: 'attacker@example.test' });
        expect(sent.status).toBe(200);
        expect(relayed).toEqual([{ action: 'approve_send', version: 'v1' }]);
        // A replay is refused before any dialog: Praxis no longer lists the draft for review.
        const replay = await send();
        expect(replay.status).toBe(409); expect(replay.json.nothing_recorded).toBe(true);
        expect(prompts).toHaveLength(2); expect(relayed).toHaveLength(1);
    });

    test('Praxis mail: a stale version is refused without asking, and edits stay click-free', async () => {
        const cookie = await bootstrap();
        const stale = await api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action: 'approve_send', version: 'v0' }, { cookie });
        expect(stale.status).toBe(409); expect(stale.json.error).toMatch(/^Draft changed; reload the current version/);
        const edit = await api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action: 'edit', version: 'v1', subject: 'Quarterly update [md1]', body: 'Edited.' }, { cookie });
        expect(edit.status).toBe(200);
        expect(prompts).toHaveLength(0);
        expect(relayed).toEqual([{ action: 'edit', version: 'v1', subject: 'Quarterly update [md1]', body: 'Edited.' }]);
    });
});
