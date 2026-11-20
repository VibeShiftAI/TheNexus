#!/usr/bin/env node
/**
 * Live check for per-action confirmation (Robert's Option A, task 5e513530).
 *
 * Runs an isolated Nexus API on http://127.0.0.1:4299 (temporary database and
 * files, throwaway keys, synthetic documents and mail: nothing real is read,
 * approved or sent) with the real local-session store, the real kernel peer
 * check, the real decision routes and the real osascript dialog. It then opens
 * check-page.html in Robert's own Google Chrome, or with --client webview in a
 * WebKit webview hosted the way the desktop app hosts the dashboard
 * (webview-host.swift). The page's script plays a script an executor added to
 * a dashboard page: it opens the local session without a click, then tries to
 * record document decisions, sends and a delegating review finish with the
 * stored proof alone, with forged confirmation fields, as replays, while
 * another dialog is open and after aborting. Every dialog is looked up in the
 * window server list (owned by osascript, outside the browser). Page results,
 * the exact dialog text, the records and the server log lines are written as
 * JSON evidence; the process exits 1 if any check fails.
 *
 * Answers: a dialog the plan leaves alone times out. A dialog the plan answers
 * is pressed through Accessibility when the screen is unlocked. While the
 * console is locked macOS lets no process answer it, so the harness closes the
 * dialog and hands the broker the planned answer; the evidence marks that as a
 * stand-in. --attended shows the plan on the page and waits for Robert's
 * clicks instead (longer dialogs, no Accessibility, no stand-in).
 *
 *   node scripts/operator-confirmation-qa/live-check.cjs [--client chrome|webview]
 *        [--attended] [--port 4299] [--wait 8] [--out <file.json>]
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const { execFile, spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const CLIENT = option('client', 'chrome');
const ATTENDED = argv.includes('--attended');
const PORT = Number(option('port', '4299'));
const WAIT = Number(option('wait', ATTENDED ? '45' : '8'));
if (!['chrome', 'webview'].includes(CLIENT) || !Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || !(WAIT >= 3 && WAIT <= 120)) {
    console.error('usage: live-check.cjs [--client chrome|webview] [--attended] [--port 4299] [--wait 8] [--out file.json]');
    process.exit(64);
}
if (process.platform !== 'darwin') {
    console.error('live-check.cjs drives a real macOS dialog and Google Chrome; run it on the Mac.');
    process.exit(64);
}
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const HERE = __dirname;
const REPO = path.resolve(HERE, '../..');
const OUT = path.resolve(option('out', path.join(REPO, 'docs/reviews/2026-11-20-operator-confirmation',
    `live-${CLIENT}${ATTENDED ? '-attended' : ''}.json`)));

// ── Isolation, before any server module loads ──────────────────────────────
// Throwaway keys only: the real operator and document keys are never read.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-opconf-live-')));
const throwaway = () => crypto.randomBytes(32).toString('base64url');
const KEYS = { operator: throwaway(), executor: throwaway(), runtime: throwaway(), relay: throwaway() };
for (const name of Object.keys(process.env)) {
    if (/^(NEXUS_|PRAXIS_|CF_|CLOUDFLARE)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
    NEXUS_DB_PATH: path.join(root, 'nexus.db'),
    NEXUS_REVIEW_BLOB_DIR: path.join(root, 'review-blobs'),
    NEXUS_LOCAL_OPERATOR_SESSIONS: '1',
    NEXUS_LOCAL_OPERATOR_UID: String(fs.statSync('/dev/console').uid),
    NEXUS_LOCAL_OPERATOR_CHROME: '1',
    NEXUS_OPERATOR_APPROVAL_KEY: KEYS.operator,
    NEXUS_DOCUMENT_APPROVAL_KEY: KEYS.executor,
    NEXUS_STAKEHOLDER_RUNTIME_KEY: KEYS.runtime,
    PRAXIS_OPERATOR_KEY: KEYS.relay,
});

// Server lines are kept for the evidence and echoed with a prefix.
const serverLog = [];
for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
        const line = parts.map(part => (typeof part === 'string' ? part : part instanceof Error ? part.message : JSON.stringify(part))).join(' ');
        serverLog.push({ at: new Date().toISOString(), level, line });
        original(`[api] ${line}`);
    };
}
const say = line => process.stdout.write(`[live-check] ${line}\n`);

const express = require('express');
const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const { createLocalOperatorSessions } = require('../../server/services/local-operator-session');
const { createLocalOperatorPeerVerifier, connectionOwner } = require('../../server/services/local-operator-peer');
const { createOperatorAuthenticator } = require('../../server/services/operator-access');
const { createDocumentDecisionAuthority } = require('../../server/services/document-decision-authority');
const confirmation = require('../../server/services/operator-confirmation');

// ── Small process helpers ──────────────────────────────────────────────────
const run = (file, args, options = {}) => new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options },
        (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const BIN = path.join(os.tmpdir(), 'nexus-opconf-bin');
async function compile(name) {
    const source = path.join(HERE, `${name}.swift`);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
    const binary = path.join(BIN, `${name}-${digest}`);
    if (!fs.existsSync(binary)) {
        fs.mkdirSync(BIN, { recursive: true });
        say(`compiling ${name}.swift`);
        const built = await run('/usr/bin/swiftc', ['-O', '-o', binary, source], { timeout: 300000 });
        if (built.code !== 0) throw new Error(`swiftc ${name}.swift failed: ${built.stderr.trim()}`);
    }
    return binary;
}
let PROBE;
async function probe(...args) {
    const result = await run(PROBE, args.map(String));
    try { return JSON.parse(result.stdout.trim()); } catch { return { error: `probe exit ${result.code}: ${result.stderr.trim()}` }; }
}
async function idleSeconds() {
    const result = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const match = result.stdout.match(/"HIDIdleTime" = (\d+)/);
    return match ? Math.round(Number(match[1]) / 1e9) : null;
}
async function processRow(pid) {
    const result = await run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'uid=', '-o', 'args='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid, ppid: Number(match[1]), uid: Number(match[2]), args: match[3] } : null;
}
// Evidence only (the real verifier decides): which process holds the client
// end of this connection, reduced to its executable and Chrome process type.
async function peerEvidence(socket) {
    const listing = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${socket.localPort}`, '-sTCP:ESTABLISHED', '-Fpn']);
    const owner = connectionOwner(listing.stdout, socket);
    if (!owner) return { owner: null };
    const row = await processRow(owner);
    const parent = row ? await processRow(row.ppid) : null;
    const brief = value => value && {
        pid: value.pid, ppid: value.ppid, uid: value.uid,
        executable: hostBinary && value.args.startsWith(`${hostBinary} `) ? hostBinary : value.args.split(' --')[0],
        type: (value.args.match(/--utility-sub-type=(\S+)/) || [])[1] || (value.args.includes(' --type=') ? 'helper' : 'main'),
        ...(value.args.includes(' --type=') ? {} : { args: value.args }),
    };
    return { owner: brief(row), parent: brief(parent) };
}

const iso = () => new Date().toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── The isolated API: real session store, peer check, routes and broker ────
const raw = new Database(process.env.NEXUS_DB_PATH);
initializeDocumentReviews(raw);
const store = createDocumentReviewStore(raw);
const project = { id: 'harness-project', name: 'Confirmation live check (synthetic)', path: root };
const task = { id: 'harness-task', project_id: project.id, name: 'Confirmation live check (synthetic)' };
const db = {
    documentReviews: store,
    getProjects: async () => [project],
    getProject: async id => (id === project.id ? project : null),
    getTask: async id => (id === task.id ? task : null),
};

const bootstraps = [];
let host = null; // the webview host child, --client webview only
let hostBinary = null;
const realVerify = createLocalOperatorPeerVerifier();
async function verifyPeer(req) {
    const peer = await peerEvidence(req.socket).catch(error => ({ error: error.message }));
    let device = await realVerify(req);
    let pin = device ? 'real verifier: kernel peer, code signature, interactive launch, console user' : null;
    // The installed desktop app only bootstraps against the live :4000, so the
    // webview run pins the host process this run started in its place.
    // (The host's argv is its binary then two URLs; the binary path has no spaces.)
    if (!device && CLIENT === 'webview' && host && peer.owner?.pid === host.pid
        && String(peer.owner?.args || '').split(' ')[0] === hostBinary && peer.owner?.uid === Number(process.env.NEXUS_LOCAL_OPERATOR_UID)) {
        device = 'mac-desktop';
        pin = 'harness pin: the webview host this run started (stands in for the desktop app cdhash pin)';
    }
    bootstraps.push({ at: iso(), device: device || null, pin, peer });
    return device;
}
const sessions = createLocalOperatorSessions({ verifyPeer, origin: ORIGIN });
const authorizeDecision = createDocumentDecisionAuthority({ authenticateOperator: createOperatorAuthenticator({ localSessions: sessions }) });

// Every dialog goes through the real showMacDialog (osascript). The wrapper
// only watches it: window lookup, Accessibility read or press, kill, stand-in.
const state = { step: null, plans: [], stepDialogs: [], pending: [], visible: false, dialogWaiters: [] };
const dialogs = [];
function show(prompt) {
    const work = (async () => {
        const plan = state.plans.length ? state.plans.shift() : 'none';
        const record = { n: dialogs.length + 1, step: state.step?.id ?? null, at: iso(), plan, title: prompt.title,
            confirm_label: prompt.confirmLabel, seconds: prompt.seconds, message: prompt.message };
        dialogs.push(record);
        state.stepDialogs.push(record);
        let child = null;
        const shown = confirmation.showMacDialog({ ...prompt, run: (file, args, options, callback) => {
            child = execFile(file, args, options, callback);
            // The script shows these four argv strings verbatim (title, text, button, seconds).
            record.osascript = { file, pid: child.pid, argv_strings: args.slice(-4) };
            return child;
        } });
        if (!child) {
            record.outcome = await shown;
            return record.outcome;
        }
        record.window = await probe('window', child.pid, 8);
        state.visible = !!record.window.found;
        for (const resolve of state.dialogWaiters.splice(0)) resolve({ visible: state.visible, window_id: record.window.window_id ?? null });
        const session = await probe('session');
        record.console_locked = !!session.locked;
        let standIn = null;
        if (plan === 'kill') {
            process.kill(child.pid, 'SIGKILL');
            record.action = 'the harness ended the dialog process (SIGKILL) before any answer';
        } else if (plan === 'confirm' || plan === 'decline') {
            const button = plan === 'confirm' ? prompt.confirmLabel : 'Cancel';
            if (ATTENDED) {
                record.action = `waiting for Robert to click ${button}`;
            } else if (!session.locked) {
                record.accessibility = await probe('press', child.pid, button, 6);
                record.action = `Accessibility press of ${button}`;
            } else {
                standIn = plan === 'confirm' ? 'confirmed' : 'declined';
                process.kill(child.pid, 'SIGTERM');
                record.action = `stand-in: the console is locked, so no process can press ${button}; the harness closed the dialog and handed the broker "${standIn}"`;
            }
        } else if (!ATTENDED && !session.locked) {
            record.accessibility = await probe('read', child.pid, 6);
        }
        const processOutcome = await shown;
        record.dialog_process_outcome = processOutcome;
        if (processOutcome === 'aborted' || plan === 'kill' || standIn) record.window_after = await probe('window', child.pid, 0);
        record.outcome = standIn || processOutcome;
        record.answer_source = standIn ? 'stand-in (console locked)'
            : plan === 'kill' ? 'none: dialog process ended'
                : processOutcome === 'aborted' ? 'none: the page aborted the request'
                    : ATTENDED ? 'Robert'
                        : record.accessibility?.pressed ? 'Accessibility press' : 'none: left unanswered';
        state.visible = false;
        return record.outcome;
    })();
    state.pending.push(work.catch(() => null));
    return work;
}
const confirmations = confirmation.createOperatorConfirmations({ show, seconds: WAIT, origin: HOST });

// Praxis stand-in for Praxis Mail: lists drafts, checks the body-bound relay
// signature and the version like Praxis does, and sends nothing.
const drafts = new Map([['md_harness', {
    id: 'md_harness', version: 'v1', status: 'draft', to: 'harness-member@example.test', cc: [],
    subject: 'Harness check: synthetic Praxis draft, nothing is sent',
    body: 'Synthetic Praxis Mail body for the operator confirmation live check.\nNothing is sent.',
}]]);
const relayed = [];
async function relay(url, options) {
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (options.method === 'GET') {
        const items = [...drafts.values()].filter(draft => !['sent', 'cancelled'].includes(draft.status));
        return reply(200, { items, counts: { drafts: items.length } });
    }
    const id = decodeURIComponent(url.split('/').pop());
    const header = options.headers?.['X-Praxis-Operator-Provenance'] || '';
    const parts = Object.fromEntries(header.split(';').slice(1).map(part => part.split('=')));
    const digest = crypto.createHash('sha256').update(JSON.stringify({ purpose: 'mail-draft-review', id, body: options.body }), 'utf8').digest('hex');
    const expected = crypto.createHmac('sha256', KEYS.relay)
        .update(`praxis-operator-provenance/v1\n${parts.surface}\n${parts.ts}\n${parts.nonce}\n${digest}`, 'utf8').digest('hex');
    const signed = typeof parts.sig === 'string' && parts.sig.length === expected.length
        && crypto.timingSafeEqual(Buffer.from(parts.sig), Buffer.from(expected));
    relayed.push({ at: iso(), id, body: options.body, signature_valid: signed });
    if (!signed) return reply(403, { error: 'operator provenance invalid' });
    const draft = drafts.get(id);
    if (!draft || draft.version !== options.body?.version) return reply(409, { error: 'Draft changed; reload the current version' });
    if (options.body.action === 'approve_send') Object.assign(draft, { status: 'sent', version: 'v2-sent' });
    return reply(200, { draft });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
// The real request-context stub from server.js (local_user on these prefixes).
const serverSource = fs.readFileSync(path.join(REPO, 'server/server.js'), 'utf8');
vm.runInNewContext(serverSource.slice(serverSource.indexOf('function authenticate(req, res, next)'),
    serverSource.indexOf("app.use('/api/write-leases'")), { app });
app.use('/api/operator-session', require('../../server/routes/operator-session')({ sessions }));
app.use('/api/documents', require('../../server/routes/documents')({ db, authorizeDecision, confirmations }));
app.use('/api/praxis/mailbox/drafts-review', require('../../server/routes/mail-draft-review')({ authorize: authorizeDecision, relay, confirmations }));

// ── Page coordination (long polls, so a hidden tab is not timer-throttled) ─
const page = fs.readFileSync(path.join(HERE, 'check-page.html'), 'utf8');
const channel = { waiting: null, queued: null, results: new Map(), waiters: new Map() };
app.get('/check', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(page));
app.get('/harness/next', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (channel.queued) {
        const message = channel.queued;
        channel.queued = null;
        return res.json(message);
    }
    channel.waiting = res;
    return undefined;
});
app.post('/harness/result', (req, res) => {
    const { step, result } = req.body || {};
    const waiter = channel.waiters.get(step);
    if (waiter) {
        channel.waiters.delete(step);
        waiter(result);
    } else channel.results.set(step, result);
    res.json({ ok: true });
});
app.get('/harness/wait-dialog', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (state.visible) return res.json({ visible: true });
    let answered = false;
    const answer = value => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        res.json(value);
    };
    const timer = setTimeout(() => answer({ visible: false, waited_seconds: 20 }), 20000);
    state.dialogWaiters.push(answer);
    return undefined;
});
function publish(message) {
    if (channel.waiting) {
        const res = channel.waiting;
        channel.waiting = null;
        res.json(message);
    } else channel.queued = message;
}
function resultOf(id, ms) {
    if (channel.results.has(id)) {
        const value = channel.results.get(id);
        channel.results.delete(id);
        return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            channel.waiters.delete(id);
            reject(new Error(`the page reported no result for ${id} within ${Math.round(ms / 1000)}s`));
        }, ms);
        channel.waiters.set(id, value => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}
const server = http.createServer(app);

// ── Synthetic records ──────────────────────────────────────────────────────
const ENVELOPE = {
    to: 'harness-recipient@example.test', cc: ['harness-copy@example.test'],
    subject: 'Harness check: synthetic message, nothing is sent',
    text: 'Synthetic body for the operator confirmation live check.\nNothing is sent.', attachments: [],
};
const docs = {};
async function call(method, url, body, headers = {}) {
    const response = await fetch(ORIGIN + url, {
        method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`seed ${method} ${url} answered ${response.status}: ${JSON.stringify(json)}`);
    return json;
}
async function seed() {
    for (const [key, intended] of [['A', 'none'], ['B', 'send'], ['C', 'none'], ['D', 'none']]) {
        const title = `Harness check ${key}: synthetic ${key === 'B' ? 'invitation' : key === 'C' ? 'review' : 'brief'} (task 5e513530)`;
        const file = path.join(root, `harness-${key.toLowerCase()}.md`);
        fs.writeFileSync(file, `# ${title}\n\nSynthetic content for the operator confirmation live check. Nothing here is real.\n`, 'utf8');
        const registered = await call('POST', '/api/documents', {
            path: file, title, project_id: project.id, task_id: task.id,
            deliverable: { key: `harness-${key.toLowerCase()}`, requires_review: true, intended_action: intended, ...(intended === 'send' ? { purpose: 'Synthetic invitation' } : {}) },
        });
        docs[key] = { id: registered.document.id, title, revision: registered.revision };
    }
    docs.B.outgoing = (await call('PUT', `/api/documents/${docs.B.id}/outgoing`, {
        revision_id: docs.B.revision.id, envelope: ENVELOPE,
        provenance: { member_id: 'harness-member', project_id: project.id, task_id: task.id, source_refs: ['harness:synthetic-source'] },
    }, { authorization: `Bearer ${KEYS.runtime}` })).outgoing;
    docs.C.review = (await call('POST', `/api/documents/${docs.C.id}/reviews`, { revision_id: docs.C.revision.id })).review;
    await call('POST', `/api/documents/reviews/${docs.C.review.id}/comments`, { kind: 'document', body: 'Synthetic comment: tighten the second paragraph.' });
}

// ── Steps and their checks ─────────────────────────────────────────────────
const DEVICE_LABEL = CLIENT === 'chrome' ? 'Google Chrome' : 'The Nexus app';
const PRAXIS_DRAFT = { ...drafts.get('md_harness') };
const PRAXIS_SEND = {
    method: 'POST', url: '/api/praxis/mailbox/drafts-review/md_harness',
    // Forged recipient and content fields: the dialog and the relay must ignore them.
    body: { action: 'approve_send', version: 'v1', to: 'attacker@example.test', cc: ['attacker-copy@example.test'], subject: 'Forged subject', body: 'Forged body' },
};
const FORGED = ['attacker@example.test', 'attacker-copy@example.test', 'Forged'];
const decide = (doc, decision, extra = {}) => ({ method: 'POST', url: `/api/documents/${doc.id}/decisions`, body: { revision_id: doc.revision.id, decision, ...extra } });
const approveSend = () => ({ method: 'POST', url: `/api/documents/${docs.B.id}/outgoing/decision`,
    body: { decision: 'approve_send', revision_id: docs.B.outgoing.revision_id, envelope_hash: docs.B.outgoing.envelope_hash } });
const finishGrant = () => ({ method: 'POST', url: `/api/documents/reviews/${docs.C.review.id}/finish`,
    body: { approve_after_changes: true, summary: 'Approve once the second paragraph is tightened.' } });
const reads = () => [
    { method: 'GET', url: '/api/documents' },
    { method: 'GET', url: `/api/documents/${docs.A.id}` },
    { method: 'GET', url: `/api/documents/${docs.A.id}/history` },
    { method: 'GET', url: `/api/documents/${docs.B.id}/outgoing` },
    { method: 'GET', url: '/api/praxis/mailbox/drafts-review?folder=drafts' },
];

const decisionsOf = doc => store.listDecisions(doc.id);
const outgoingOf = () => store.getOutgoing(docs.B.id);
const approvals = () => store.listOutgoingEvents(docs.B.id).filter(event => event.event === 'approved');
const logged = text => serverLog.some(entry => entry.line.includes(text));
const responseOf = (result, index = 0) => (Array.isArray(result) ? result[index] : result) || {};
const refIn = dialog => ((dialog?.message || '').match(/^Ref ([0-9a-f]{8})$/m) || [])[1] || null;
const shows = (message, line) => (line instanceof RegExp ? line.test(message) : message.includes(line));
const refusedAs = (response, status, code) => [`refused ${status} ${code}, nothing recorded`,
    response.status === status && response.json?.code === code && response.json?.nothing_recorded === true,
    { status: response.status ?? null, code: response.json?.code ?? null, nothing_recorded: response.json?.nothing_recorded ?? null }];
const noDialog = context => ['no dialog was shown', context.dialogs.length === 0, context.dialogs.length];
const decisionDialog = (doc, decision) => ({
    title: decision === 'approve' ? 'Nexus: approve this document?' : 'Nexus: request changes?',
    label: decision === 'approve' ? 'Approve' : 'Request changes',
    lines: [`${decision === 'approve' ? 'Approve' : 'Request changes to'} "${doc.title}"?`,
        new RegExp(`[Rr]evision ${doc.revision.id}, content sha256 ${doc.revision.content_hash.slice(0, 12)}`)],
});
const mailDialog = ({ to, cc, subject }) => ({ title: 'Nexus: send this email?', label: 'Send', lines: [`Send to ${to}: "${subject}"?`, `Cc: ${cc.length ? cc.join(', ') : 'none'}`] });
function dialogChecks(context, expect) {
    const dialog = context.dialogs[0];
    const checks = [['exactly one dialog was shown', context.dialogs.length === 1, context.dialogs.length]];
    if (!dialog) return checks;
    checks.push(
        ['the dialog window belongs to osascript, outside the browser', dialog.window?.found === true && dialog.window.owner === 'osascript', dialog.window],
        ['the dialog title names the action', dialog.title === expect.title, dialog.title],
        ['the dialog text names the exact action and subject', expect.lines.every(line => shows(dialog.message, line)), expect.lines.map(String)],
        ['the confirm button names the action', dialog.confirm_label === expect.label, dialog.confirm_label],
        ['osascript received exactly this title and text as argv', dialog.osascript?.argv_strings?.[0] === dialog.title && dialog.osascript?.argv_strings?.[1] === dialog.message],
        [`the dialog says who asked (${DEVICE_LABEL} on ${HOST})`, dialog.message.includes(`Requested by ${DEVICE_LABEL} on ${HOST} at `)],
    );
    if (expect.absent) checks.push(['the dialog shows none of the forged request values', expect.absent.every(text => !dialog.message.includes(text)), expect.absent]);
    if (expect.ref !== undefined) checks.push(['the dialog Ref matches the API answer', !!expect.ref && refIn(dialog) === expect.ref, { dialog: refIn(dialog), api: expect.ref ?? null }]);
    if (Array.isArray(dialog.accessibility?.texts)) {
        checks.push(['Accessibility read the same text on screen', expect.lines.every(line => dialog.accessibility.texts.some(text => shows(text, line))), dialog.accessibility.texts]);
    }
    if (expect.outcome) checks.push([`the dialog outcome was ${expect.outcome}`, dialog.outcome === expect.outcome, { outcome: dialog.outcome, source: dialog.answer_source }]);
    return checks;
}

const step = {
    // The evidence keeps each read's status and top-level fields, not the bodies.
    reads: (id, label) => ({ id, label, plans: [], kind: 'sequence', requests: reads,
        keep: result => (Array.isArray(result) ? result.map(r => ({ status: r.status, fields: r.json && typeof r.json === 'object' ? Object.keys(r.json) : null })) : result),
        verify: (result, context) => [
            ['every read answered 200', Array.isArray(result) && result.length === 5 && result.every(r => r.status === 200), Array.isArray(result) ? result.map(r => r.status) : result],
            noDialog(context)] }),
    storedProofDecision: (id, doc, memo) => ({ id, label: `Approve document ${doc === docs.A ? 'A' : 'D'} with the stored proof alone; nobody answers`, plans: ['none'], kind: 'sequence',
        requests: () => [decide(doc, 'approve', { note: 'Stored proof only.' })],
        verify: (result, context) => {
            const response = responseOf(result);
            memo.refused = response.json?.confirmation_ref;
            return [refusedAs(response, 403, 'operator_confirmation_timeout'),
                ...dialogChecks(context, { ...decisionDialog(doc, 'approve'), ref: memo.refused, outcome: 'timeout' }),
                ['the document has no decision', decisionsOf(doc).length === 0, decisionsOf(doc).length]];
        } }),
    confirmedDecision: (id, doc, clientId, memo) => ({ id, label: 'Approve document A and confirm in the Mac dialog', plans: ['confirm'], kind: 'sequence',
        requests: () => [decide(doc, 'approve', { note: 'Confirmed in the Mac dialog.', client_decision_id: clientId })],
        verify: (result, context) => {
            const response = responseOf(result);
            const rows = decisionsOf(doc);
            const row = rows[0] || {};
            memo.confirmed = { id: response.json?.decision?.id ?? null, ref: response.json?.confirmation_ref ?? null };
            const expect = decisionDialog(doc, 'approve');
            return [['recorded 201', response.status === 201, response.status],
                ...dialogChecks(context, { ...expect, lines: [...expect.lines, 'Note:', 'Confirmed in the Mac dialog.'], ref: memo.confirmed.ref, outcome: 'confirmed' }),
                ['exactly one decision on the document', rows.length === 1, rows.length],
                ['the record is the confirmed identity', row.revision_id === doc.revision.id && row.content_hash === doc.revision.content_hash
                    && row.decision === 'approve' && row.note === 'Confirmed in the Mac dialog.' && row.client_decision_id === clientId,
                { revision_id: row.revision_id ?? null, content_hash: row.content_hash ?? null, decision: row.decision ?? null, note: row.note ?? null, client_decision_id: row.client_decision_id ?? null }],
                ['recorded on Robert\'s operator credential through the local session', row.authority === 'operator_credential' && row.actor_id === 'local_user' && row.recorded_by === 'operator',
                    { authority: row.authority ?? null, actor_id: row.actor_id ?? null, recorded_by: row.recorded_by ?? null }],
                ['the server logged the record with the dialog Ref', logged(`[Documents] approve recorded for ${doc.id} revision ${doc.revision.id} (authority=operator_credential, operator confirmation ref=${memo.confirmed.ref})`)]];
        } }),
    storedProofOutgoing: id => ({ id, label: 'Approve sending document B\'s email with the stored proof alone; nobody answers', plans: ['none'], kind: 'sequence',
        requests: () => [approveSend()],
        verify: (result, context) => [refusedAs(responseOf(result), 403, 'operator_confirmation_timeout'),
            ...dialogChecks(context, { ...mailDialog(ENVELOPE), ref: responseOf(result).json?.confirmation_ref, outcome: 'timeout' }),
            ['the email is still a draft with no send grant', outgoingOf()?.status === 'draft' && !outgoingOf()?.grant, { status: outgoingOf()?.status ?? null }]] }),
    storedProofPraxis: id => ({ id, label: 'Send the Praxis Mail draft with the stored proof alone and forged recipient fields; nobody answers', plans: ['none'], kind: 'sequence',
        requests: () => [PRAXIS_SEND],
        verify: (result, context) => [refusedAs(responseOf(result), 403, 'operator_confirmation_timeout'),
            ...dialogChecks(context, { ...mailDialog(PRAXIS_DRAFT), absent: FORGED, ref: responseOf(result).json?.confirmation_ref, outcome: 'timeout' }),
            ['nothing reached Praxis', relayed.length === 0, relayed.length]] }),
};

function chromeSteps() {
    const memo = {};
    const finishExpect = { title: 'Nexus: finish this review?', label: 'Approve after changes',
        lines: [() => `Finish your review of "${docs.C.title}"`, 'This lets the executor that applies your changes record your approval of the revised version.',
            'Comments in this review: 1.', 'Summary:', 'Approve once the second paragraph is tightened.'] };
    const finishDialog = () => ({ ...finishExpect, lines: finishExpect.lines.map(line => (typeof line === 'function' ? line() : line)) });
    return [
        step.reads('S01', 'Browse and read with the open session'),
        step.storedProofDecision('S02', docs.A, memo),
        { id: 'S03', label: 'Approve document A with forged confirmation fields and headers; nobody answers', plans: ['none'], kind: 'sequence',
            requests: () => [{ ...decide(docs.A, 'approve', { note: 'Forged confirmation.', confirmed: true, confirmation: 'confirmed',
                operator_confirmation: { ok: true, ref: memo.refused }, confirmation_ref: memo.refused, via: 'access_session', authority: 'access_user' }),
            headers: { 'x-nexus-confirmation': 'confirmed', 'x-nexus-operator-confirmation': String(memo.refused), 'x-nexus-confirmed': '1' } }],
            verify: (result, context) => [refusedAs(responseOf(result), 403, 'operator_confirmation_timeout'),
                ...dialogChecks(context, { ...decisionDialog(docs.A, 'approve'), ref: responseOf(result).json?.confirmation_ref, outcome: 'timeout' }),
                ['document A has no decision', decisionsOf(docs.A).length === 0, decisionsOf(docs.A).length]] },
        step.confirmedDecision('S04', docs.A, 'harness-a-1', memo),
        { id: 'S05', label: 'Replay the confirmed request, then repeat it without its idempotency key; nobody answers', plans: ['none'], kind: 'sequence',
            requests: () => [decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.', client_decision_id: 'harness-a-1' }),
                decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.' })],
            verify: (result, context) => {
                const [replay = {}, again = {}] = Array.isArray(result) ? result : [];
                return [['the exact replay returns the same record, marked duplicate, before any dialog', replay.status === 200 && replay.json?.duplicate === true
                    && !!memo.confirmed?.id && replay.json?.decision?.id === memo.confirmed.id, { status: replay.status ?? null, duplicate: replay.json?.duplicate ?? null }],
                refusedAs(again, 403, 'operator_confirmation_timeout'),
                ['the earlier confirmation was not reused: the repeat asked again', context.dialogs.length === 1 && refIn(context.dialogs[0]) !== memo.confirmed?.ref,
                    { dialogs: context.dialogs.map(refIn), confirmed: memo.confirmed?.ref ?? null }],
                ['still exactly one decision on document A', decisionsOf(docs.A).length === 1, decisionsOf(docs.A).length]];
            } },
        step.storedProofOutgoing('S06'),
        { id: 'S07', label: 'Approve sending document B\'s email and confirm in the Mac dialog', plans: ['confirm'], kind: 'sequence', requests: () => [approveSend()],
            verify: (result, context) => {
                const response = responseOf(result);
                const row = outgoingOf();
                memo.sent = { approved_at: row?.grant?.approved_at ?? null, ref: response.json?.confirmation_ref ?? null };
                const expect = mailDialog(ENVELOPE);
                return [['approved 200', response.status === 200 && response.json?.outgoing?.status === 'approved', response.status],
                    ...dialogChecks(context, { ...expect, lines: [...expect.lines, 'Message:', ENVELOPE.text], ref: memo.sent.ref, outcome: 'confirmed' }),
                    ['the send grant is for exactly the confirmed envelope', row?.grant?.envelope_hash === docs.B.outgoing.envelope_hash && row?.grant?.authority === 'operator_credential',
                        { envelope_hash: row?.grant?.envelope_hash ?? null, authority: row?.grant?.authority ?? null }],
                    ['exactly one approval event', approvals().length === 1, approvals().length],
                    ['the server logged the approval with the dialog Ref', logged(`[DocumentOutgoing] approve_send recorded for ${docs.B.id} revision ${docs.B.revision.id} after operator confirmation ref=${memo.sent.ref}`)]];
            } },
        { id: 'S08', label: 'Replay the approved send', plans: [], kind: 'sequence', requests: () => [approveSend()],
            verify: (result, context) => [['answered 200 with the same approval', responseOf(result).status === 200 && !!memo.sent?.approved_at
                && responseOf(result).json?.outgoing?.grant?.approved_at === memo.sent.approved_at, responseOf(result).status ?? null],
            noDialog(context), ['still exactly one approval event', approvals().length === 1, approvals().length]] },
        step.storedProofPraxis('S09'),
        { id: 'S10', label: 'Send the Praxis Mail draft (same forged request) and confirm in the Mac dialog', plans: ['confirm'], kind: 'sequence', requests: () => [PRAXIS_SEND],
            verify: (result, context) => {
                const ref = refIn(context.dialogs[0]);
                return [['Praxis accepted the send 200', responseOf(result).status === 200, responseOf(result).status ?? null],
                    ...dialogChecks(context, { ...mailDialog(PRAXIS_DRAFT), absent: FORGED, outcome: 'confirmed' }),
                    ['exactly one signed relay, carrying only the confirmed version', relayed.length === 1 && relayed[0].signature_valid === true
                        && JSON.stringify(relayed[0].body) === JSON.stringify({ action: 'approve_send', version: 'v1' }), relayed.map(entry => entry.body)],
                    ['the server logged the relay with the dialog Ref', !!ref && logged(`[MailDraftReview] relaying approve_send for md_harness version v1 after operator confirmation ref=${ref}`)]];
            } },
        { id: 'S11', label: 'Replay the confirmed Praxis Mail send', plans: [], kind: 'sequence', requests: () => [PRAXIS_SEND],
            verify: (result, context) => [['refused 409 before any dialog, nothing recorded', responseOf(result).status === 409 && responseOf(result).json?.nothing_recorded === true,
                { status: responseOf(result).status ?? null, error: responseOf(result).json?.error ?? null }],
            noDialog(context), ['still exactly one relay', relayed.length === 1, relayed.length]] },
        { id: 'S12', label: 'Finish the review of document C with the approve-after-changes grant; decline in the Mac dialog', plans: ['decline'], kind: 'sequence', requests: () => [finishGrant()],
            verify: (result, context) => {
                const review = store.getReview(docs.C.review.id);
                return [refusedAs(responseOf(result), 403, 'operator_confirmation_declined'),
                    ...dialogChecks(context, { ...finishDialog(), ref: responseOf(result).json?.confirmation_ref, outcome: 'declined' }),
                    ['the review is still a draft without the grant', review?.status === 'draft' && !review?.approval_delegated,
                        { status: review?.status ?? null, approval_delegated: review?.approval_delegated ?? null }],
                    ['no submission exists', !store.getSubmissionForReview(docs.C.review.id)]];
            } },
        { id: 'S13', label: 'Finish the same review with the grant and confirm in the Mac dialog', plans: ['confirm'], kind: 'sequence', requests: () => [finishGrant()],
            verify: (result, context) => {
                const review = store.getReview(docs.C.review.id);
                const submission = store.getSubmissionForReview(docs.C.review.id);
                const ref = refIn(context.dialogs[0]);
                return [['finished 202', responseOf(result).status === 202, responseOf(result).status ?? null],
                    ...dialogChecks(context, { ...finishDialog(), outcome: 'confirmed' }),
                    ['the review is submitted once, with the grant, on Robert\'s operator credential', review?.status === 'submitted' && !!review?.approval_delegated
                        && review?.submitted_authority === 'operator_credential' && !!submission,
                    { status: review?.status ?? null, approval_delegated: review?.approval_delegated ?? null, submitted_authority: review?.submitted_authority ?? null, submission: submission?.id ?? null }],
                    ['the server logged the finish with the dialog Ref', !!ref && logged(`finished with approval delegated (authority=operator_credential, submission=${submission?.id}, operator confirmation ref=${ref})`)]];
            } },
        { id: 'S14', label: 'Approve document D while the dialog process ends before any answer', plans: ['kill'], kind: 'sequence',
            requests: () => [decide(docs.D, 'approve', { note: 'The dialog process ends.' })],
            verify: (result, context) => [refusedAs(responseOf(result), 503, 'operator_confirmation_unavailable'),
                ...dialogChecks(context, { ...decisionDialog(docs.D, 'approve'), ref: responseOf(result).json?.confirmation_ref, outcome: 'unavailable' }),
                ['the dialog is gone', context.dialogs[0]?.window_after?.found === false, context.dialogs[0]?.window_after ?? null],
                ['no fallback: document D has no decision', decisionsOf(docs.D).length === 0, decisionsOf(docs.D).length]] },
        { id: 'S15', label: 'Approve document D, then the page aborts while the dialog is open', plans: ['none'], kind: 'abort',
            request: () => decide(docs.D, 'approve', { note: 'The page gives up.' }),
            verify: (result, context) => [['the page saw its request aborted after the dialog appeared', result?.visible?.visible === true && result?.result?.aborted === true, result],
                ...dialogChecks(context, { ...decisionDialog(docs.D, 'approve'), outcome: 'aborted' }),
                ['the dialog closed with the request', context.dialogs[0]?.window_after?.found === false, context.dialogs[0]?.window_after ?? null],
                ['the server logged the aborted confirmation', !!refIn(context.dialogs[0]) && logged(`[OperatorConfirmation] aborted document_decision ref=${refIn(context.dialogs[0])}`)],
                ['document D has no decision', decisionsOf(docs.D).length === 0, decisionsOf(docs.D).length]] },
        { id: 'S16', label: 'Approve document D twice at once; nobody answers the first dialog', plans: ['none'], kind: 'busy',
            first: () => decide(docs.D, 'approve', { note: 'First request.' }),
            second: () => decide(docs.D, 'request_changes', { note: 'Second request while the first dialog is open.' }),
            verify: (result, context) => [refusedAs(result?.first || {}, 403, 'operator_confirmation_timeout'),
                refusedAs(result?.second || {}, 409, 'operator_confirmation_busy'),
                ['one dialog at a time', context.dialogs.length === 1, context.dialogs.length],
                ['document D has no decision', decisionsOf(docs.D).length === 0, decisionsOf(docs.D).length]] },
        { id: 'S17', label: 'Request changes on document D; a third dialog in a row goes unanswered', plans: ['none'], kind: 'sequence',
            requests: () => [decide(docs.D, 'request_changes', { note: 'Third unanswered dialog.' })],
            verify: (result, context) => [refusedAs(responseOf(result), 403, 'operator_confirmation_timeout'),
                ...dialogChecks(context, { ...decisionDialog(docs.D, 'request_changes'), ref: responseOf(result).json?.confirmation_ref, outcome: 'timeout' }),
                ['document D has no decision', decisionsOf(docs.D).length === 0, decisionsOf(docs.D).length]] },
        { id: 'S18', label: 'Approve document D right after three unanswered dialogs', plans: [], kind: 'sequence',
            requests: () => [decide(docs.D, 'approve', { note: 'Asked again right away.' })],
            verify: (result, context) => [refusedAs(responseOf(result), 429, 'operator_confirmation_paused'), noDialog(context),
                ['document D has no decision', decisionsOf(docs.D).length === 0, decisionsOf(docs.D).length]] },
    ];
}

function webviewSteps() {
    const memo = {};
    return [
        step.reads('W01', 'Browse and read with the session the native host planted'),
        step.storedProofDecision('W02', docs.A, memo),
        step.storedProofPraxis('W03'),
        step.confirmedDecision('W04', docs.A, 'harness-w-1', memo),
        step.storedProofOutgoing('W05'),
    ];
}

function instruction(item) {
    const lead = ATTENDED ? '' : 'Unattended run: ';
    const plan = item.plans[0];
    if (item.kind === 'busy') return `${lead}leave the first Mac dialog alone; the second request is refused while it is open.`;
    if (item.kind === 'abort') return `${lead}leave the Mac dialog alone; the page gives up and the dialog closes with it.`;
    if (!plan) return `${lead}no Mac dialog is expected for this step.`;
    if (plan === 'none') return `${lead}leave the Mac dialog alone; it closes by itself after ${WAIT} seconds.`;
    if (plan === 'kill') return `${lead}the harness ends this Mac dialog itself; do not click.`;
    if (plan === 'decline') return ATTENDED ? 'Click Cancel in the Mac dialog.' : `${lead}the harness answers Cancel.`;
    return ATTENDED ? 'Click the confirm button in the Mac dialog (Approve, Send or Approve after changes).' : `${lead}the harness confirms this dialog.`;
}

function bootChecks(page) {
    const first = bootstraps[0] || {};
    const checks = [['the session opened without a click or form', page?.session_after?.operator === true && page?.proof_stored === true,
        { session_after: page?.session_after ?? null, proof_stored: page?.proof_stored ?? null }]];
    if (CLIENT === 'chrome') {
        checks.push(
            ['before the bootstrap the page had no operator session', page?.session_before?.operator === false, page?.session_before ?? null],
            ['the bootstrap answered 201 with a proof', page?.bootstrap?.status === 201 && page.bootstrap.proof_received === true, page?.bootstrap ?? null],
            ['the real kernel peer check identified Robert\'s Google Chrome', first.device === 'mac-chrome' && /^real verifier/.test(first.pin || ''), { device: first.device ?? null, pin: first.pin ?? null }],
            ['the connection came from Chrome\'s network service', first.peer?.owner?.type === 'network.mojom.NetworkService'
                && String(first.peer?.owner?.executable).startsWith('/Applications/Google Chrome.app/Contents/Frameworks/'), first.peer?.owner ?? null],
            ['its parent is the interactive Google Chrome', first.peer?.parent?.executable === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                && first.peer?.parent?.ppid === 1, first.peer?.parent ?? null]);
    } else {
        checks.push(
            ['before the host bootstrapped, the page had no operator session', page?.session_before?.operator === false, page?.session_before ?? null],
            ['the native host bootstrapped the session (harness pin in place of the desktop app pin)', first.device === 'mac-desktop' && /^harness pin/.test(first.pin || ''),
                { device: first.device ?? null, pin: first.pin ?? null }],
            ['the bootstrap connection came from the host process itself, not the page', first.peer?.owner?.pid === host?.pid && first.peer?.owner?.executable === hostBinary,
                first.peer?.owner ?? null],
            ['the host stored the proof with the desktop app\'s origin-checked evaluation', page?.host_ready === true, page?.host_ready ?? null]);
    }
    checks.push(['exactly one bootstrap', bootstraps.length === 1, bootstraps.length], ['no dialog during bootstrap', dialogs.length === 0, dialogs.length]);
    return checks;
}

// ── Run ────────────────────────────────────────────────────────────────────
const toChecks = list => list.map(([name, pass, detail]) => ({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) }));
const replacer = (_key, value) => (value instanceof RegExp ? String(value) : value);
const report = {
    task: '5e513530-0d18-5939-87b8-583274b5bf5e',
    generated_at: iso(),
    command: ['node scripts/operator-confirmation-qa/live-check.cjs', ...argv].join(' '),
    client: CLIENT, attended: ATTENDED, origin: ORIGIN, wait_seconds: WAIT,
    isolation: {
        data: 'a temporary directory and SQLite database, removed after the run',
        keys: 'random throwaway keys generated for this run; the real operator and document keys were never read',
        praxis: 'an in-process stand-in that checks the body-bound relay signature and the version, and sends nothing',
        live_services: 'the live :3000 dashboard and :4000 API were not contacted',
    },
    dialog_script: confirmation.SCRIPT,
    steps: [],
};
const hostLog = [];
let finished = false;
function finalState() {
    if (!docs.A) return null;
    const decisionView = row => ({ id: row.id, revision_id: row.revision_id, content_hash: row.content_hash, decision: row.decision, note: row.note,
        actor_id: row.actor_id, authority: row.authority, recorded_by: row.recorded_by, client_decision_id: row.client_decision_id, created_at: row.created_at });
    const outgoing = store.getOutgoing(docs.B.id);
    const review = docs.C.review ? store.getReview(docs.C.review.id) : null;
    return {
        documents: Object.fromEntries(Object.entries(docs).map(([key, doc]) => [key, { id: doc.id, title: doc.title, revision_id: doc.revision.id, content_hash: doc.revision.content_hash }])),
        decisions: { A: decisionsOf(docs.A).map(decisionView), D: decisionsOf(docs.D).map(decisionView) },
        outgoing_B: outgoing && { status: outgoing.status, envelope_hash: outgoing.envelope_hash, grant: outgoing.grant && { authority: outgoing.grant.authority, envelope_hash: outgoing.grant.envelope_hash, approved_at: outgoing.grant.approved_at } },
        outgoing_B_events: store.listOutgoingEvents(docs.B.id).map(event => ({ event: event.event, authority: event.authority, created_at: event.created_at })),
        review_C: review && { status: review.status, approval_delegated: !!review.approval_delegated, submitted_authority: review.submitted_authority ?? null,
            submission: store.getSubmissionForReview(review.id)?.id ?? null },
        praxis_relays: relayed,
        praxis_drafts: [...drafts.values()].map(draft => ({ id: draft.id, status: draft.status, version: draft.version, to: draft.to })),
    };
}
function finish(error) {
    if (finished) return;
    finished = true;
    try {
        report.final_state = finalState();
        report.dialogs_total = dialogs.length;
        report.server_log = serverLog.filter(entry => /\[(OperatorConfirmation|Documents|DocumentOutgoing|MailDraftReview|OperatorAccess)\]/.test(entry.line));
        if (hostLog.length) report.host_log = hostLog;
        const all = [...(report.boot?.checks || []), ...report.steps.flatMap(item => item.checks)];
        const failed = all.filter(item => !item.pass);
        const answers = {};
        for (const dialog of dialogs) answers[dialog.answer_source || 'unknown'] = (answers[dialog.answer_source || 'unknown'] || 0) + 1;
        report.summary = { steps: report.steps.length, dialogs: dialogs.length, dialog_answers: answers, checks: all.length, passed: all.length - failed.length,
            failed: failed.map(item => item.name), ...(error ? { error: error.message } : {}) };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, `${JSON.stringify(report, replacer, 2)}\n`, 'utf8');
        say(`evidence: ${path.relative(REPO, OUT)} (${report.summary.passed}/${report.summary.checks} checks passed${error ? `; stopped: ${error.message}` : ''})`);
        process.exitCode = error ? 2 : failed.length ? 1 : 0;
    } finally {
        try { host?.kill('SIGTERM'); } catch { /* already gone */ }
        server.closeAllConnections?.();
        server.close();
        try { raw.close(); } catch { /* already closed */ }
        fs.rmSync(root, { recursive: true, force: true });
        setTimeout(() => process.exit(process.exitCode ?? 2), 200).unref();
    }
}

async function main() {
    const overall = setTimeout(() => finish(new Error('the run took longer than 20 minutes')), 20 * 60 * 1000);
    overall.unref();
    PROBE = await compile('dialog-probe');
    const hostPath = CLIENT === 'webview' ? await compile('webview-host') : null;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, '127.0.0.1', resolve);
    });
    say(`isolated API on ${ORIGIN}; temporary data in ${root}`);
    await seed();
    report.console_at_start = { at: iso(), ...(await probe('session')), idle_seconds: await idleSeconds() };
    state.step = { id: 'boot' };
    if (CLIENT === 'chrome') {
        const target = `${ORIGIN}/check?client=chrome`;
        const opened = await run('/usr/bin/open', ['-a', 'Google Chrome', target]);
        report.client_launch = { command: `open -a "Google Chrome" ${target}`, exit: opened.code };
    } else {
        hostBinary = hostPath;
        host = spawn(hostPath, [ORIGIN, `${ORIGIN}/check?client=webview`], { stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => hostLog.push(...String(chunk).split('\n').filter(Boolean)));
        report.client_launch = { command: `${hostPath} ${ORIGIN} ${ORIGIN}/check?client=webview`, pid: host.pid };
    }
    const page = await resultOf('boot', 120000);
    report.boot = { page, bootstraps, checks: toChecks(bootChecks(page)) };
    if (!report.boot.checks.every(item => item.pass)) throw new Error('the local session did not open as expected; see boot.checks');
    for (const item of CLIENT === 'chrome' ? chromeSteps() : webviewSteps()) {
        state.step = item;
        state.stepDialogs = [];
        state.pending = [];
        state.plans = [...item.plans];
        const sent = { id: item.id, label: item.label, kind: item.kind, instruction: instruction(item),
            ...(item.requests ? { requests: item.requests() } : {}),
            ...(item.first ? { first: item.first(), second: item.second() } : {}),
            ...(item.request ? { request: item.request() } : {}) };
        say(`${item.id} ${item.label}`);
        publish({ step: sent });
        const result = await resultOf(item.id, (WAIT + 40) * 2000);
        await Promise.all(state.pending);
        await pause(250);
        let checks;
        try { checks = toChecks(item.verify(result, { dialogs: state.stepDialogs })); } catch (error) { checks = toChecks([['the step checks ran', false, error.message]]); }
        report.steps.push({ id: item.id, label: item.label, plans: item.plans, sent, result: item.keep ? item.keep(result) : result, dialogs: state.stepDialogs, checks });
        for (const failed of checks.filter(entry => !entry.pass)) say(`  FAIL ${failed.name}`);
        say(`  ${checks.filter(entry => entry.pass).length}/${checks.length} checks passed`);
    }
    publish({ done: true });
    report.end = await resultOf('end', 30000).catch(error => ({ error: error.message }));
    report.console_at_end = { at: iso(), ...(await probe('session')), idle_seconds: await idleSeconds() };
    clearTimeout(overall);
    finish(null);
}

main().catch(error => {
    say(`error: ${error.message}`);
    finish(error);
});
