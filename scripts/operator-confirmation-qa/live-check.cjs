#!/usr/bin/env node
/**
 * Live check for per-action confirmation (Robert's Option A, task 5e513530).
 *
 * Runs an isolated Nexus API on http://127.0.0.1:4299 (temporary database and
 * files, throwaway keys, synthetic documents and mail: nothing real is read,
 * approved or sent) with the real local-session store, the real kernel peer
 * check, the real decision routes, the real confirmation broker and the real
 * osascript dialog. It then opens check-page.html in Robert's own Google
 * Chrome, or with --client webview in a WebKit webview host that sets up the
 * session the way the desktop app does (webview-host.swift; a stand-in for
 * the app, see below). The page's script plays a script an executor added to
 * a dashboard page: it opens the local session without a click, then tries to
 * record document decisions, sends and a delegating review finish with the
 * stored proof alone, with forged confirmation fields, as replays and while
 * another dialog is open. Every dialog is looked up in the window server list
 * (owned by osascript, outside the browser). Page results, the exact dialog
 * text, the records before, during and after each dialog and the server log
 * lines are written as JSON evidence; the process exits 1 if any check fails.
 *
 * The harness never answers a dialog: it has no code that clicks, presses or
 * types, and dialog-probe has no such mode. A dialog ends in one of four ways,
 * and each dialog record says which: Robert clicks a button (--attended only;
 * the outcome is what osascript returned), the page gives up and its request
 * ends, the harness ends the dialog process (the unavailable path), or the hold
 * step watches a dialog stay open past the longest life the previous version
 * allowed and then the page gives up. Without --attended only the steps that
 * need no answer run. --attended waits for Robert to press Start on the page
 * and tells him which button to click for each dialog.
 *
 * --client webview: the installed desktop app talks only to the live :4000
 * and :3000, so this run pins the webview host it started in place of the
 * app's code-signature check. That is component evidence for the webview
 * path, not a run of the desktop app.
 *
 *   node scripts/operator-confirmation-qa/live-check.cjs [--client chrome|webview]
 *        [--attended] [--port 4299] [--out <file.json>]
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const { execFile, execFileSync, spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const CLIENT = option('client', 'chrome');
const ATTENDED = argv.includes('--attended');
const PORT = Number(option('port', '4299'));
if (!['chrome', 'webview'].includes(CLIENT) || !Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
    console.error('usage: live-check.cjs [--client chrome|webview] [--attended] [--port 4299] [--out file.json]');
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
    `live-${CLIENT}-${ATTENDED ? 'attended' : 'unattended'}.json`)));
// The version before this one (8cf041e9, operator-confirmation.js) gave a
// dialog up after 120 seconds and killed osascript 15 seconds after that. The
// hold step watches one dialog stay open longer than that, unanswered.
const PREVIOUS_LONGEST_DIALOG_MS = (120 + 15) * 1000;
// The harness's own guards, so a broken run stops instead of hanging. None of
// them is product behavior, and each can only fail a check or stop the run,
// never pass one. A dialog itself is never timed: a step waits for as long as
// its dialog is open.
const GUARDS = {
    // A helper command (git, ioreg, ps, lsof, open) that has not answered by
    // then is stopped and yields no evidence, which fails the checks needing it.
    helper_command_ms: 30000,
    // The dialog window must show in the window server list this soon after
    // osascript starts, and be gone this soon after its outcome.
    dialog_window_appears_s: 8,
    dialog_window_gone_s: 2,
    // A passive Accessibility read of the dialog text (unlocked screen only).
    accessibility_read_s: 3,
    // The page must load and open its session, and must report its end.
    page_boot_ms: 120000,
    page_end_ms: 30000,
};

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
    execFile(file, args, { encoding: 'utf8', timeout: GUARDS.helper_command_ms, ...options },
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
        // The compiler runs to completion (once per source version).
        const built = await run('/usr/bin/swiftc', ['-O', '-o', binary, source], { timeout: 0 });
        if (built.code !== 0) throw new Error(`swiftc ${name}.swift failed: ${built.stderr.trim()}`);
    }
    return binary;
}
let PROBE;
// Every probe mode bounds itself with its own wait argument, so no process timeout here.
async function probe(...args) {
    const result = await run(PROBE, args.map(String), { timeout: 0 });
    try { return JSON.parse(result.stdout.trim()); } catch { return { error: `probe exit ${result.code}: ${result.stderr.trim()}` }; }
}
// Milliseconds since the last keyboard or mouse event (IOHIDSystem HIDIdleTime, in ns).
async function idleMs() {
    const result = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    const match = result.stdout.match(/"HIDIdleTime" = (\d+)/);
    return match ? Math.round(Number(match[1]) / 1e6) : null;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
        pin = 'stand-in pin: the webview host this run started, in place of the desktop app code-signature check (not the desktop app)';
    }
    bootstraps.push({ at: iso(), device: device || null, pin, peer });
    return device;
}
const sessions = createLocalOperatorSessions({ verifyPeer, origin: ORIGIN });
const authorizeDecision = createDocumentDecisionAuthority({ authenticateOperator: createOperatorAuthenticator({ localSessions: sessions }) });

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

// ── Synthetic records and what is recorded on them ─────────────────────────
const ENVELOPE = {
    to: 'harness-recipient@example.test', cc: ['harness-copy@example.test'],
    subject: 'Harness check: synthetic message, nothing is sent',
    text: 'Synthetic body for the operator confirmation live check.\nNothing is sent.', attachments: [],
};
const docs = {};
const decisionsOf = doc => store.listDecisions(doc.id);
const outgoingOf = () => store.getOutgoing(docs.B.id);
const approvals = () => store.listOutgoingEvents(docs.B.id).filter(event => event.event === 'approved');
// Everything a step could record, as counts and states.
const snapshot = () => (docs.E ? {
    decisions: Object.fromEntries(['A', 'C', 'D', 'E'].map(key => [key, decisionsOf(docs[key]).length])),
    outgoing_B: outgoingOf()?.status ?? null,
    send_approvals_B: approvals().length,
    review_C: store.getReview(docs.C.review.id)?.status ?? null,
    review_C_submission: store.getSubmissionForReview(docs.C.review.id)?.id ?? null,
    praxis_relays: relayed.length,
} : null);

// ── Dialogs: the real showMacDialog (osascript), watched, never answered ───
const state = { step: null, plans: [], stepDialogs: [], pending: [], visible: false, dialogWaiters: [], releaseWaiters: [] };
const dialogs = [];
const release = (list, value) => { for (const resolve of list.splice(0)) resolve(value); };
function show(prompt) {
    return (async () => {
        const plan = state.plans.length ? state.plans.shift() : 'unplanned';
        const record = { n: dialogs.length + 1, step: state.step?.id ?? null, at: iso(), plan, title: prompt.title,
            confirm_label: prompt.confirmLabel, message: prompt.message };
        dialogs.push(record);
        state.stepDialogs.push(record);
        let child = null;
        const shown = confirmation.showMacDialog({ ...prompt, run: (file, args, options, callback) => {
            child = execFile(file, args, options, callback);
            // The script shows these three argv strings verbatim (title, text, confirm button).
            record.osascript = { file, pid: child.pid, argv_strings: args.slice(-3),
                options: { timeout: options.timeout ?? null, maxBuffer: options.maxBuffer ?? null } };
            return child;
        } });
        if (!child) {
            record.outcome = await shown;
            return record.outcome;
        }
        record.window = await probe('window', child.pid, GUARDS.dialog_window_appears_s);
        const opened = Date.now();
        const session = await probe('session');
        record.console_locked = !!session.locked;
        // A passive read of the text on screen; Accessibility withholds it behind the lock screen.
        if (!session.locked) record.accessibility = await probe('read', child.pid, GUARDS.accessibility_read_s);
        record.records_while_open = snapshot();
        state.visible = !!record.window.found;
        release(state.dialogWaiters, { visible: state.visible, window_id: record.window.window_id ?? null });
        if (plan === 'kill' || plan === 'unplanned') {
            process.kill(child.pid, 'SIGKILL');
            record.action = plan === 'kill' ? 'the harness ended the dialog process (SIGKILL) before any answer'
                : 'an unexpected dialog: the harness ended its process (SIGKILL) without answering it';
        } else if (plan === 'hold') {
            // The measurement itself: is the unanswered dialog still on screen once
            // it has been open longer than the previous version let it live?
            const watch = await probe('watch', child.pid, Math.ceil((PREVIOUS_LONGEST_DIALOG_MS - (Date.now() - opened)) / 1000));
            record.hold = { ...watch, open_ms: Date.now() - opened, osascript_running: alive(child.pid), records: snapshot() };
            record.action = 'nobody answered; once the dialog had been watched, the page was told to give up';
            release(state.releaseWaiters, { released: true });
        } else if (plan === 'confirm' || plan === 'decline') {
            record.action = `waiting for Robert to click ${plan === 'confirm' ? prompt.confirmLabel : 'Cancel'}`;
        } else {
            record.action = 'nobody answers; the page gives up';
        }
        const outcome = await shown;
        record.ended_at = iso();
        record.open_ms = Date.now() - opened;
        record.idle_ms_at_end = await idleMs();
        record.outcome = outcome;
        record.answer_source = ['confirmed', 'declined'].includes(outcome) ? 'a click on the dialog: osascript returned the button'
            : outcome === 'aborted' ? 'none: the request ended and the broker closed the dialog'
                : 'none: the dialog process ended without an answer';
        record.window_after = await probe('watch', child.pid, GUARDS.dialog_window_gone_s);
        state.visible = false;
        return outcome;
    })();
}
const broker = confirmation.createOperatorConfirmations({ show, origin: HOST });
// The routes use the real broker. The wrapper only notes each call, so a step
// is checked after the broker has returned and logged.
const confirmations = {
    confirm: input => {
        const call = broker.confirm(input);
        state.pending.push(call.catch(() => null));
        return call;
    },
    status: broker.status,
};

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
// Answered when the step's dialog is on screen, or when the step ends.
app.get('/harness/wait-dialog', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (state.visible) return res.json({ visible: true });
    state.dialogWaiters.push(value => res.json(value));
    return undefined;
});
// Answered when the hold step has watched its dialog, or when the step ends.
app.get('/harness/release', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    state.releaseWaiters.push(value => res.json(value));
});
function publish(message) {
    if (channel.waiting) {
        const res = channel.waiting;
        channel.waiting = null;
        res.json(message);
    } else channel.queued = message;
}
// `ms` is only a guard for the page loading at all; a step's result is awaited
// for as long as its dialog is open.
function resultOf(id, ms = null) {
    if (channel.results.has(id)) {
        const value = channel.results.get(id);
        channel.results.delete(id);
        return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
        const timer = ms === null ? null : setTimeout(() => {
            channel.waiters.delete(id);
            reject(new Error(`the page reported no result for ${id} within ${Math.round(ms / 1000)}s`));
        }, ms);
        channel.waiters.set(id, value => {
            if (timer) clearTimeout(timer);
            resolve(value);
        });
    });
}
const server = http.createServer(app);

async function call(method, url, body, headers = {}) {
    const response = await fetch(ORIGIN + url, {
        method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`seed ${method} ${url} answered ${response.status}: ${JSON.stringify(json)}`);
    return json;
}
const TITLES = {
    A: 'Harness check A: synthetic brief (task 5e513530)',
    B: 'Harness check B: synthetic invitation (task 5e513530)',
    C: 'Harness check C: synthetic review (task 5e513530)',
    D: 'Harness check D: synthetic brief (task 5e513530)',
    E: 'Harness check E: synthetic brief, leave this dialog alone (task 5e513530)',
};
async function seed() {
    for (const key of Object.keys(TITLES)) {
        const intended = key === 'B' ? 'send' : 'none';
        const file = path.join(root, `harness-${key.toLowerCase()}.md`);
        fs.writeFileSync(file, `# ${TITLES[key]}\n\nSynthetic content for the operator confirmation live check. Nothing here is real.\n`, 'utf8');
        const registered = await call('POST', '/api/documents', {
            path: file, title: TITLES[key], project_id: project.id, task_id: task.id,
            deliverable: { key: `harness-${key.toLowerCase()}`, requires_review: true, intended_action: intended, ...(intended === 'send' ? { purpose: 'Synthetic invitation' } : {}) },
        });
        docs[key] = { key, id: registered.document.id, title: TITLES[key], revision: registered.revision };
    }
    docs.B.outgoing = (await call('PUT', `/api/documents/${docs.B.id}/outgoing`, {
        revision_id: docs.B.revision.id, envelope: ENVELOPE,
        provenance: { member_id: 'harness-member', project_id: project.id, task_id: task.id, source_refs: ['harness:synthetic-source'] },
    }, { authorization: `Bearer ${KEYS.runtime}` })).outgoing;
    docs.C.review = (await call('POST', `/api/documents/${docs.C.id}/reviews`, { revision_id: docs.C.revision.id })).review;
    await call('POST', `/api/documents/reviews/${docs.C.review.id}/comments`, { kind: 'document', body: 'Synthetic comment: tighten the second paragraph.' });
}

// ── Requests ───────────────────────────────────────────────────────────────
const DEVICE_LABEL = CLIENT === 'chrome' ? 'Google Chrome' : 'The Nexus app';
const PRAXIS_DRAFT = { ...drafts.get('md_harness') };
// Forged recipient and content fields: the dialog and the relay must ignore them.
const PRAXIS_SEND = () => ({
    method: 'POST', url: '/api/praxis/mailbox/drafts-review/md_harness',
    body: { action: 'approve_send', version: 'v1', to: 'attacker@example.test', cc: ['attacker-copy@example.test'], subject: 'Forged subject', body: 'Forged body' },
});
const FORGED = ['attacker@example.test', 'attacker-copy@example.test', 'Forged'];
const decide = (doc, decision, extra = {}) => ({ method: 'POST', url: `/api/documents/${doc.id}/decisions`, body: { revision_id: doc.revision.id, decision, ...extra } });
// Every confirmation field and header a page script could invent, carrying the
// Ref of the most recent real dialog.
const lastRef = () => refIn(dialogs[dialogs.length - 1]) || 'deadbeef';
const forgedDecide = doc => {
    const ref = lastRef();
    return { ...decide(doc, 'approve', { note: 'Forged confirmation.', confirmed: true, confirmation: 'confirmed',
        operator_confirmation: { ok: true, ref }, confirmation_ref: ref, via: 'access_session', authority: 'access_user' }),
    headers: { 'x-nexus-confirmation': 'confirmed', 'x-nexus-operator-confirmation': ref, 'x-nexus-confirmed': '1' } };
};
const approveSend = () => ({ method: 'POST', url: `/api/documents/${docs.B.id}/outgoing/decision`,
    body: { decision: 'approve_send', revision_id: docs.B.outgoing.revision_id, envelope_hash: docs.B.outgoing.envelope_hash } });
const finishApproving = () => ({ method: 'POST', url: `/api/documents/reviews/${docs.C.review.id}/finish`,
    body: { approve_after_changes: true, summary: 'Approved. The second paragraph could be tighter.' } });
const reads = () => [
    { method: 'GET', url: '/api/documents' },
    { method: 'GET', url: `/api/documents/${docs.A.id}` },
    { method: 'GET', url: `/api/documents/${docs.A.id}/history` },
    { method: 'GET', url: `/api/documents/${docs.B.id}/outgoing` },
    { method: 'GET', url: '/api/praxis/mailbox/drafts-review?folder=drafts' },
];

// ── Checks ─────────────────────────────────────────────────────────────────
const logged = text => serverLog.some(entry => entry.line.includes(text));
const responseOf = (result, index = 0) => (Array.isArray(result) ? result[index] : result) || {};
const refIn = dialog => ((dialog?.message || '').match(/^Ref ([0-9a-f]{8})$/m) || [])[1] || null;
const shows = (message, line) => (line instanceof RegExp ? line.test(message) : message.includes(line));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refusedAs = (response, status, code) => [`refused ${status} ${code}, nothing recorded`,
    response.status === status && response.json?.code === code && response.json?.nothing_recorded === true,
    { status: response.status ?? null, code: response.json?.code ?? null, nothing_recorded: response.json?.nothing_recorded ?? null }];
const noDialog = context => ['no dialog was shown', context.dialogs.length === 0, context.dialogs.length];
const unchangedWhileOpen = (context, name = 'nothing was recorded while the dialog was open') => [name,
    !!context.dialogs[0] && same(context.dialogs[0].records_while_open, context.before), { before: context.before, while_open: context.dialogs[0]?.records_while_open ?? null }];
const nothingNew = (context, name = 'nothing was recorded') => [name, same(snapshot(), context.before), { before: context.before, after: snapshot() }];
const closed = (context, name = 'the dialog closed with the request') => [name, context.dialogs[0]?.window_after?.still_open === false, context.dialogs[0]?.window_after ?? null];
const gaveUp = entry => ['the page saw the dialog appear, then gave up (its request was aborted)',
    entry?.visible?.visible === true && entry?.result?.aborted === true, entry ?? null];
const outcomeLogged = (context, outcome) => {
    const ref = refIn(context.dialogs[0]);
    return [`the server logged the ${outcome} confirmation with the dialog Ref`,
        !!ref && serverLog.some(entry => entry.line.startsWith(`[OperatorConfirmation] ${outcome} `) && entry.line.includes(` ref=${ref} `)), ref];
};
// Robert's answer: what osascript returned, after a keyboard or mouse event that
// came after the dialog appeared (HID idle at the end is shorter than the time
// the dialog was open). The harness posts no input of any kind.
const clicked = (context, outcome) => {
    const dialog = context.dialogs[0] || {};
    return [
        [`osascript returned ${outcome}: Robert's click`, dialog.outcome === outcome && String(dialog.answer_source).startsWith('a click'),
            { outcome: dialog.outcome ?? null, answer_source: dialog.answer_source ?? null }],
        ['a keyboard or mouse event came after the dialog appeared (HID idle at the answer is shorter than the time it was open)',
            Number.isFinite(dialog.idle_ms_at_end) && Number.isFinite(dialog.open_ms) && dialog.idle_ms_at_end < dialog.open_ms,
            { idle_ms_at_end: dialog.idle_ms_at_end ?? null, open_ms: dialog.open_ms ?? null }],
    ];
};
const decisionDialog = (doc, decision) => ({
    title: decision === 'approve' ? 'Nexus: approve this document?' : 'Nexus: request changes?',
    label: decision === 'approve' ? 'Approve' : 'Request changes',
    lines: [`${decision === 'approve' ? 'Approve' : 'Request changes to'} "${doc.title}"?`,
        new RegExp(`[Rr]evision ${doc.revision.id}, content sha256 ${doc.revision.content_hash.slice(0, 12)}`)],
});
const mailDialog = ({ to, cc, subject }) => ({ title: 'Nexus: send this email?', label: 'Send', lines: [`Send to ${to}: "${subject}"?`, `Cc: ${cc.length ? cc.join(', ') : 'none'}`] });
const finishDialog = () => ({ title: 'Nexus: finish this review?', label: 'Approve this version',
    lines: [`Finish your review of "${docs.C.title}"`, 'This approves this exact version now and keeps your summary and comments with it as a note. It starts no revision and sends nothing.',
        'Comments in this review: 1.', 'Summary:', 'Approved. The second paragraph could be tighter.'] });
function dialogChecks(context, expect) {
    const dialog = context.dialogs[0];
    const checks = [['exactly one dialog was shown', context.dialogs.length === 1, context.dialogs.length]];
    if (!dialog) return checks;
    checks.push(
        ['the dialog window belongs to osascript, outside the browser', dialog.window?.found === true && dialog.window.owner === 'osascript', dialog.window],
        ['the dialog title names the action', dialog.title === expect.title, dialog.title],
        ['the dialog text names the exact action and subject', expect.lines.every(line => shows(dialog.message, line)), expect.lines.map(String)],
        ['the confirm button names the action', dialog.confirm_label === expect.label, dialog.confirm_label],
        ['osascript received exactly this title, text and button as argv', same(dialog.osascript?.argv_strings, [dialog.title, dialog.message, dialog.confirm_label])],
        ['osascript ran with no timeout and no output cap', dialog.osascript?.options?.timeout === null && dialog.osascript?.options?.maxBuffer === null, dialog.osascript?.options ?? null],
        [`the dialog says who asked (${DEVICE_LABEL} on ${HOST})`, dialog.message.includes(`Requested by ${DEVICE_LABEL} on ${HOST} at `)],
    );
    if (expect.absent) checks.push(['the dialog shows none of the forged request values', expect.absent.every(text => !dialog.message.includes(text)), expect.absent]);
    if (expect.ref !== undefined) checks.push(['the dialog Ref matches the API answer', !!expect.ref && refIn(dialog) === expect.ref, { dialog: refIn(dialog), api: expect.ref ?? null }]);
    if (Array.isArray(dialog.accessibility?.texts)) {
        checks.push(['Accessibility read the same text on screen', expect.lines.every(line => dialog.accessibility.texts.some(text => shows(text, line))), dialog.accessibility.texts]);
    }
    if (expect.outcome) checks.push([`the dialog ended as ${expect.outcome}`, dialog.outcome === expect.outcome, { outcome: dialog.outcome, answer_source: dialog.answer_source }]);
    return checks;
}

// ── Steps ──────────────────────────────────────────────────────────────────
// `plans` lists how each dialog of the step ends: 'abort' (the page gives up),
// 'decline' or 'confirm' (Robert clicks; --attended only), 'kill' (the harness
// ends the dialog process) or 'hold' (watched, then the page gives up).
const readsStep = (id, label) => ({ id, label, plans: [], kind: 'sequence', requests: reads,
    // The evidence keeps each read's status and top-level fields, not the bodies.
    keep: result => (Array.isArray(result) ? result.map(r => ({ status: r.status, fields: r.json && typeof r.json === 'object' ? Object.keys(r.json) : null })) : result),
    verify: (result, context) => [
        ['every read answered 200', Array.isArray(result) && result.length === 5 && result.every(r => r.status === 200), Array.isArray(result) ? result.map(r => r.status) : result],
        noDialog(context)] });

// One request that must record nothing. `ending` is 'abort' or 'decline'.
function refusedStep({ id, what, ending, request, dialog, extra = () => [] }) {
    return { id, label: `${what}; ${ending === 'decline' ? 'Robert clicks Cancel' : 'nobody answers and the page gives up once the dialog is open'}`,
        plans: [ending], kind: 'sequence', requests: () => [{ ...request(), ...(ending === 'abort' ? { abort: true } : {}) }],
        verify: (result, context) => {
            const entry = responseOf(result);
            const ended = ending === 'decline'
                ? [refusedAs(entry, 403, 'operator_confirmation_declined'), ...clicked(context, 'declined')]
                : [gaveUp(entry), outcomeLogged(context, 'aborted'), closed(context)];
            return [...ended,
                ...dialogChecks(context, { ...dialog(), ...(ending === 'decline' ? { ref: entry.json?.confirmation_ref } : {}), outcome: ending === 'decline' ? 'declined' : 'aborted' }),
                unchangedWhileOpen(context), nothingNew(context), ...extra(result, context)];
        } };
}

// One request Robert confirms; `recorded` checks the record it made.
function confirmedStep({ id, what, button, request, dialog, recorded }) {
    return { id, label: `${what}; Robert clicks ${button}`, plans: ['confirm'], button, kind: 'sequence', requests: () => [request()],
        verify: (result, context) => [...recorded(responseOf(result), context), ...clicked(context, 'confirmed'),
            ...dialogChecks(context, { ...dialog(), outcome: 'confirmed' }),
            unchangedWhileOpen(context, 'nothing was recorded before Robert clicked')] };
}

const killStep = id => ({ id, label: 'Approve document D while the harness ends the dialog process before any answer', plans: ['kill'], kind: 'sequence',
    requests: () => [decide(docs.D, 'approve', { note: 'The dialog process ends.' })],
    verify: (result, context) => [refusedAs(responseOf(result), 503, 'operator_confirmation_unavailable'),
        ...dialogChecks(context, { ...decisionDialog(docs.D, 'approve'), ref: responseOf(result).json?.confirmation_ref, outcome: 'unavailable' }),
        closed(context, 'the dialog is gone'), unchangedWhileOpen(context), nothingNew(context, 'no fallback: nothing was recorded')] });

const busyStep = id => ({ id, label: 'Approve document D twice at once: the second is refused while the first dialog is open, then the page gives up on the first',
    plans: ['abort'], kind: 'busy',
    first: () => decide(docs.D, 'approve', { note: 'First request.' }),
    second: () => decide(docs.D, 'request_changes', { note: 'Second request while the first dialog is open.' }),
    verify: (result, context) => [refusedAs(result?.second || {}, 409, 'operator_confirmation_busy'),
        ['the page gave up on the first request after its dialog appeared', result?.visible?.visible === true && result?.first?.aborted === true,
            { visible: result?.visible ?? null, first: result?.first ?? null }],
        ['one dialog at a time', context.dialogs.length === 1, context.dialogs.length],
        outcomeLogged(context, 'aborted'), closed(context), unchangedWhileOpen(context), nothingNew(context)] });

const holdStep = id => ({ id, label: `Approve document E; nobody answers for longer than the previous version let a dialog live (${PREVIOUS_LONGEST_DIALOG_MS / 1000} s), then the page gives up`,
    plans: ['hold'], kind: 'sequence', requests: () => [{ ...decide(docs.E, 'approve', { note: 'Nobody answers this dialog.' }), abort: true, hold: true }],
    verify: (result, context) => {
        const dialog = context.dialogs[0] || {};
        return [gaveUp(responseOf(result)),
            [`the unanswered dialog was still on screen after more than ${PREVIOUS_LONGEST_DIALOG_MS / 1000} s`,
                dialog.hold?.still_open === true && dialog.hold?.open_ms > PREVIOUS_LONGEST_DIALOG_MS, dialog.hold ?? null],
            ['its osascript process was still waiting for an answer then', dialog.hold?.osascript_running === true],
            ['nothing was recorded during that time', same(dialog.hold?.records, context.before), dialog.hold?.records ?? null],
            ...dialogChecks(context, { ...decisionDialog(docs.E, 'approve'), outcome: 'aborted' }),
            outcomeLogged(context, 'aborted'), closed(context), unchangedWhileOpen(context), nothingNew(context)];
    } });

function chromeSteps() {
    const memo = {};
    const negative = ATTENDED ? 'decline' : 'abort';
    const steps = [
        readsStep('S01', 'Browse and read with the open session'),
        refusedStep({ id: 'S02', what: 'Approve document D with the stored proof alone', ending: 'abort',
            request: () => decide(docs.D, 'approve', { note: 'Stored proof only.' }), dialog: () => decisionDialog(docs.D, 'approve') }),
        refusedStep({ id: 'S03', what: 'Approve document A with forged confirmation fields and headers (carrying the last dialog Ref)', ending: negative,
            request: () => forgedDecide(docs.A), dialog: () => decisionDialog(docs.A, 'approve') }),
    ];
    if (ATTENDED) {
        steps.push(
            confirmedStep({ id: 'S04', what: 'Approve document A', button: 'Approve',
                request: () => decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.', client_decision_id: 'harness-a-1' }),
                dialog: () => { const expect = decisionDialog(docs.A, 'approve'); return { ...expect, lines: [...expect.lines, 'Note:', 'Confirmed in the Mac dialog.'] }; },
                recorded: (response, context) => {
                    const rows = decisionsOf(docs.A);
                    const row = rows[0] || {};
                    memo.confirmed = { id: response.json?.decision?.id ?? null, ref: response.json?.confirmation_ref ?? null };
                    return [['recorded 201', response.status === 201, response.status ?? null],
                        ['the dialog Ref matches the API answer', !!memo.confirmed.ref && refIn(context.dialogs[0]) === memo.confirmed.ref, memo.confirmed.ref],
                        ['exactly one decision on document A', rows.length === 1, rows.length],
                        ['the record is the confirmed identity', row.revision_id === docs.A.revision.id && row.content_hash === docs.A.revision.content_hash
                            && row.decision === 'approve' && row.note === 'Confirmed in the Mac dialog.' && row.client_decision_id === 'harness-a-1',
                        { revision_id: row.revision_id ?? null, content_hash: row.content_hash ?? null, decision: row.decision ?? null, note: row.note ?? null, client_decision_id: row.client_decision_id ?? null }],
                        ['recorded on Robert\'s operator credential through the local session', row.authority === 'operator_credential' && row.actor_id === 'local_user' && row.recorded_by === 'operator',
                            { authority: row.authority ?? null, actor_id: row.actor_id ?? null, recorded_by: row.recorded_by ?? null }],
                        ['the server logged the record with the dialog Ref', logged(`[Documents] approve recorded for ${docs.A.id} revision ${docs.A.revision.id} (authority=operator_credential, operator confirmation ref=${memo.confirmed.ref})`)]];
                } }),
            { id: 'S05', label: 'Replay the confirmed request, then repeat it without its idempotency key; nobody answers the new dialog and the page gives up', plans: ['abort'], kind: 'sequence',
                requests: () => [decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.', client_decision_id: 'harness-a-1' }),
                    { ...decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.' }), abort: true }],
                verify: (result, context) => {
                    const [replay = {}, again = {}] = Array.isArray(result) ? result : [];
                    return [['the exact replay returns the same record, marked duplicate, without a dialog', replay.status === 200 && replay.json?.duplicate === true
                        && !!memo.confirmed?.id && replay.json?.decision?.id === memo.confirmed.id && context.dialogs.length === 1,
                    { status: replay.status ?? null, duplicate: replay.json?.duplicate ?? null }],
                    gaveUp(again),
                    ['the earlier confirmation was not reused: the repeat asked again', context.dialogs.length === 1 && !!refIn(context.dialogs[0]) && refIn(context.dialogs[0]) !== memo.confirmed?.ref,
                        { dialogs: context.dialogs.map(refIn), confirmed: memo.confirmed?.ref ?? null }],
                    outcomeLogged(context, 'aborted'), closed(context), unchangedWhileOpen(context), nothingNew(context, 'still exactly one decision on document A')];
                } },
        );
    }
    steps.push(refusedStep({ id: 'S06', what: 'Approve sending document B\'s email with the stored proof alone', ending: negative,
        request: approveSend, dialog: () => mailDialog(ENVELOPE) }));
    if (ATTENDED) {
        steps.push(
            confirmedStep({ id: 'S07', what: 'Approve sending document B\'s email', button: 'Send', request: approveSend,
                dialog: () => { const expect = mailDialog(ENVELOPE); return { ...expect, lines: [...expect.lines, 'Message:', ENVELOPE.text] }; },
                recorded: (response, context) => {
                    const row = outgoingOf();
                    memo.sent = { approved_at: row?.grant?.approved_at ?? null, ref: response.json?.confirmation_ref ?? null };
                    return [['approved 200', response.status === 200 && response.json?.outgoing?.status === 'approved', response.status ?? null],
                        ['the dialog Ref matches the API answer', !!memo.sent.ref && refIn(context.dialogs[0]) === memo.sent.ref, memo.sent.ref],
                        ['the send grant is for exactly the confirmed envelope', row?.grant?.envelope_hash === docs.B.outgoing.envelope_hash && row?.grant?.authority === 'operator_credential',
                            { envelope_hash: row?.grant?.envelope_hash ?? null, authority: row?.grant?.authority ?? null }],
                        ['exactly one approval event', approvals().length === 1, approvals().length],
                        ['the server logged the approval with the dialog Ref', logged(`[DocumentOutgoing] approve_send recorded for ${docs.B.id} revision ${docs.B.revision.id} after operator confirmation ref=${memo.sent.ref}`)]];
                } }),
            { id: 'S08', label: 'Replay the approved send', plans: [], kind: 'sequence', requests: () => [approveSend()],
                verify: (result, context) => [['answered 200 with the same approval', responseOf(result).status === 200 && !!memo.sent?.approved_at
                    && responseOf(result).json?.outgoing?.grant?.approved_at === memo.sent.approved_at, responseOf(result).status ?? null],
                noDialog(context), nothingNew(context, 'still exactly one approval event')] },
        );
    }
    steps.push(refusedStep({ id: 'S09', what: 'Send the Praxis Mail draft with the stored proof alone and forged recipient fields', ending: negative,
        request: PRAXIS_SEND, dialog: () => ({ ...mailDialog(PRAXIS_DRAFT), absent: FORGED }) }));
    if (ATTENDED) {
        steps.push(
            confirmedStep({ id: 'S10', what: 'Send the Praxis Mail draft (the same forged request)', button: 'Send', request: PRAXIS_SEND,
                dialog: () => ({ ...mailDialog(PRAXIS_DRAFT), absent: FORGED }),
                recorded: (response, context) => {
                    const ref = refIn(context.dialogs[0]);
                    return [['Praxis accepted the send 200', response.status === 200, response.status ?? null],
                        ['exactly one signed relay, carrying only the confirmed version', relayed.length === 1 && relayed[0].signature_valid === true
                            && same(relayed[0].body, { action: 'approve_send', version: 'v1' }), relayed.map(entry => entry.body)],
                        ['the server logged the relay with the dialog Ref', !!ref && logged(`[MailDraftReview] relaying approve_send for md_harness version v1 after operator confirmation ref=${ref}`)]];
                } }),
            { id: 'S11', label: 'Replay the confirmed Praxis Mail send', plans: [], kind: 'sequence', requests: () => [PRAXIS_SEND()],
                verify: (result, context) => [['refused 409 before any dialog, nothing recorded', responseOf(result).status === 409 && responseOf(result).json?.nothing_recorded === true,
                    { status: responseOf(result).status ?? null, error: responseOf(result).json?.error ?? null }],
                noDialog(context), nothingNew(context, 'still exactly one relay')] },
        );
    }
    steps.push(refusedStep({ id: 'S12', what: 'Finish the review of document C, approving this version with a note', ending: negative,
        request: finishApproving, dialog: finishDialog }));
    if (ATTENDED) {
        steps.push(confirmedStep({ id: 'S13', what: 'Finish the same review, approving this version', button: 'Approve this version', request: finishApproving, dialog: finishDialog,
            recorded: (response, context) => {
                const review = store.getReview(docs.C.review.id);
                const submission = store.getSubmissionForReview(docs.C.review.id);
                const recordedOnC = decisionsOf(docs.C);
                const ref = refIn(context.dialogs[0]);
                return [['finished 202', response.status === 202, response.status ?? null],
                    ['the review is submitted once, with one approval of this revision on Robert\'s operator credential', review?.status === 'submitted' && !review?.approval_delegated
                        && review?.submitted_authority === 'operator_credential' && !!submission && recordedOnC.length === 1 && recordedOnC[0].id === review?.approval_decision_id
                        && recordedOnC[0].decision === 'approve' && recordedOnC[0].revision_id === docs.C.revision.id && recordedOnC[0].authority === 'operator_credential',
                    { status: review?.status ?? null, approval_decision_id: review?.approval_decision_id ?? null, submitted_authority: review?.submitted_authority ?? null, submission: submission?.id ?? null, decisions: recordedOnC.length }],
                    ['the server logged the finish with the dialog Ref', !!ref && logged(`finished with approval of revision ${docs.C.revision.id} recorded (authority=operator_credential, submission=${submission?.id}, operator confirmation ref=${ref})`)]];
            } }));
    }
    steps.push(killStep('S14'), busyStep('S15'));
    // Robert's time is not spent on a dialog nobody answers for minutes.
    if (!ATTENDED) steps.push(holdStep('S16'));
    return steps;
}

function webviewSteps() {
    const steps = [
        readsStep('W01', 'Browse and read with the session the native host planted'),
        refusedStep({ id: 'W02', what: 'Approve document D with the stored proof alone', ending: 'abort',
            request: () => decide(docs.D, 'approve', { note: 'Stored proof only.' }), dialog: () => decisionDialog(docs.D, 'approve') }),
        refusedStep({ id: 'W03', what: 'Send the Praxis Mail draft with the stored proof alone and forged recipient fields', ending: 'abort',
            request: PRAXIS_SEND, dialog: () => ({ ...mailDialog(PRAXIS_DRAFT), absent: FORGED }) }),
        refusedStep({ id: 'W04', what: 'Approve sending document B\'s email with the stored proof alone', ending: 'abort',
            request: approveSend, dialog: () => mailDialog(ENVELOPE) }),
        refusedStep({ id: 'W05', what: 'Approve document A with forged confirmation fields and headers (carrying the last dialog Ref)', ending: ATTENDED ? 'decline' : 'abort',
            request: () => forgedDecide(docs.A), dialog: () => decisionDialog(docs.A, 'approve') }),
    ];
    if (ATTENDED) {
        steps.push(confirmedStep({ id: 'W06', what: 'Approve document A', button: 'Approve',
            request: () => decide(docs.A, 'approve', { note: 'Confirmed in the Mac dialog.', client_decision_id: 'harness-w-1' }),
            dialog: () => decisionDialog(docs.A, 'approve'),
            recorded: response => {
                const rows = decisionsOf(docs.A);
                return [['recorded 201', response.status === 201, response.status ?? null],
                    ['exactly one decision on document A, for the confirmed revision', rows.length === 1 && rows[0].revision_id === docs.A.revision.id
                        && rows[0].content_hash === docs.A.revision.content_hash && rows[0].authority === 'operator_credential', rows.length]];
            } }));
    }
    return steps;
}

function instruction(item) {
    const lead = ATTENDED ? '' : 'Unattended run: ';
    const plan = item.plans[0];
    if (item.kind === 'busy') return `${lead}leave the Mac dialog alone; the second request is refused while it is open, then the page gives up on the first.`;
    if (!plan) return `${lead}no Mac dialog is expected for this step.`;
    if (plan === 'abort') return `${lead}leave the Mac dialog alone; the page gives up as soon as it appears, and it closes.`;
    if (plan === 'hold') return `${lead}leave the Mac dialog alone; it stays open unanswered for over ${PREVIOUS_LONGEST_DIALOG_MS / 1000} seconds, then the page gives up and it closes.`;
    if (plan === 'kill') return `${lead}the harness ends this Mac dialog's process itself; do not click.`;
    if (plan === 'decline') return 'Click Cancel in the Mac dialog.';
    return `Click ${item.button} in the Mac dialog.`;
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
            ['the native host bootstrapped the session (stand-in pin, not the desktop app)', first.device === 'mac-desktop' && /^stand-in pin/.test(first.pin || ''),
                { device: first.device ?? null, pin: first.pin ?? null }],
            ['the bootstrap connection came from the host process itself, not the page', first.peer?.owner?.pid === host?.pid && first.peer?.owner?.executable === hostBinary,
                first.peer?.owner ?? null],
            ['the host stored the proof with the desktop app\'s origin-checked evaluation', page?.host_ready === true, page?.host_ready ?? null]);
    }
    checks.push(['exactly one bootstrap', bootstraps.length === 1, bootstraps.length], ['no dialog during bootstrap', dialogs.length === 0, dialogs.length],
        ['the dialog script has no give-up time', !confirmation.SCRIPT.join('\n').includes('giving up'), confirmation.SCRIPT.filter(line => line.includes('display dialog'))]);
    return checks;
}

// ── Run ────────────────────────────────────────────────────────────────────
const toChecks = list => list.map(([name, pass, detail]) => ({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) }));
const replacer = (_key, value) => (value instanceof RegExp ? String(value) : value);
// Which code ran: the commit plus a hash of each file under test, so the
// evidence can be matched to the working tree it came from.
const UNDER_TEST = ['server/services/operator-confirmation.js', 'server/services/local-operator-session.js', 'server/services/local-operator-peer.js',
    'server/services/operator-access.js', 'server/services/document-decision-authority.js', 'server/routes/documents.js', 'server/routes/document-outgoing.js',
    'server/routes/mail-draft-review.js', 'server/routes/operator-session.js', 'db/document-reviews.js', 'db/document-outgoing.js',
    'scripts/operator-confirmation-qa/live-check.cjs', 'scripts/operator-confirmation-qa/check-page.html',
    'scripts/operator-confirmation-qa/dialog-probe.swift', 'scripts/operator-confirmation-qa/webview-host.swift'];
function sourceOf() {
    const git = args => { try { return execFileSync('/usr/bin/git', ['-C', REPO, ...args], { encoding: 'utf8' }).replace(/\s+$/, ''); } catch { return null; } };
    return {
        head: git(['rev-parse', 'HEAD']),
        uncommitted_files_under_test: (git(['status', '--porcelain', '--', ...UNDER_TEST]) || '').split('\n').filter(Boolean),
        sha256: Object.fromEntries(UNDER_TEST.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, file))).digest('hex')])),
    };
}
const report = {
    task: '5e513530-0d18-5939-87b8-583274b5bf5e',
    generated_at: iso(),
    command: ['node scripts/operator-confirmation-qa/live-check.cjs', ...argv].join(' '),
    client: CLIENT, attended: ATTENDED, origin: ORIGIN,
    source: sourceOf(),
    harness: {
        answers_dialogs: false,
        dialog_endings: 'Robert clicks (--attended only; the outcome is what osascript returned), the page gives up, the harness ends the dialog process, or the hold step watches the dialog and then the page gives up',
        probe_modes: ['session', 'window', 'watch', 'read'],
        previous_longest_dialog_ms: PREVIOUS_LONGEST_DIALOG_MS,
        guards: GUARDS,
        ...(CLIENT === 'webview' ? { client_note: 'a WebKit webview host this run started, pinned in place of the desktop app code-signature check: component evidence for the webview path, not the desktop app' } : {}),
    },
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
    if (!docs.E) return null;
    const decisionView = row => ({ id: row.id, revision_id: row.revision_id, content_hash: row.content_hash, decision: row.decision, note: row.note,
        actor_id: row.actor_id, authority: row.authority, recorded_by: row.recorded_by, client_decision_id: row.client_decision_id, created_at: row.created_at });
    const outgoing = store.getOutgoing(docs.B.id);
    const review = store.getReview(docs.C.review.id);
    return {
        documents: Object.fromEntries(Object.entries(docs).map(([key, doc]) => [key, { id: doc.id, title: doc.title, revision_id: doc.revision.id, content_hash: doc.revision.content_hash }])),
        decisions: Object.fromEntries(['A', 'C', 'D', 'E'].map(key => [key, decisionsOf(docs[key]).map(decisionView)])),
        outgoing_B: outgoing && { status: outgoing.status, envelope_hash: outgoing.envelope_hash, grant: outgoing.grant && { authority: outgoing.grant.authority, envelope_hash: outgoing.grant.envelope_hash, approved_at: outgoing.grant.approved_at } },
        outgoing_B_events: store.listOutgoingEvents(docs.B.id).map(event => ({ event: event.event, authority: event.authority, created_at: event.created_at })),
        review_C: review && { status: review.status, approval_decision_id: review.approval_decision_id ?? null, submitted_authority: review.submitted_authority ?? null,
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
        const endings = {};
        for (const dialog of dialogs) endings[dialog.answer_source || 'unknown'] = (endings[dialog.answer_source || 'unknown'] || 0) + 1;
        report.summary = { steps: report.steps.length, dialogs: dialogs.length, dialog_endings: endings, checks: all.length, passed: all.length - failed.length,
            failed: failed.map(item => item.name), ...(error ? { error: error.message } : {}) };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, `${JSON.stringify(report, replacer, 2)}\n`, 'utf8');
        say(`evidence: ${path.relative(REPO, OUT)} (${report.summary.passed}/${report.summary.checks} checks passed${error ? `; stopped: ${error.message}` : ''})`);
        process.exitCode = error ? 2 : failed.length ? 1 : 0;
    } finally {
        try { host?.kill('SIGTERM'); } catch { /* already gone */ }
        try { raw.close(); } catch { /* already closed */ }
        fs.rmSync(root, { recursive: true, force: true });
        server.closeAllConnections?.();
        server.close(() => process.exit(process.exitCode ?? 2));
    }
}

async function main() {
    PROBE = await compile('dialog-probe');
    const hostPath = CLIENT === 'webview' ? await compile('webview-host') : null;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(PORT, '127.0.0.1', resolve);
    });
    say(`isolated API on ${ORIGIN}; temporary data in ${root}`);
    await seed();
    report.console_at_start = { at: iso(), ...(await probe('session')), idle_ms: await idleMs() };
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
    // Guard for the page loading at all (no dialog is open yet).
    const page = await resultOf('boot', GUARDS.page_boot_ms);
    report.boot = { page, bootstraps, checks: toChecks(bootChecks(page)) };
    if (!report.boot.checks.every(item => item.pass)) throw new Error('the local session did not open as expected; see boot.checks');
    if (ATTENDED) {
        say('waiting for Robert to press Start on the page');
        publish({ step: { id: 'start', label: 'Robert starts the attended check', kind: 'start',
            instruction: 'Robert: press Start when you are at the Mac. Mac dialogs follow; this line says which button to click for each.' } });
        const started = await resultOf('start');
        report.start = { at: iso(), page: started, idle_ms: await idleMs(), console: await probe('session') };
    }
    for (const item of CLIENT === 'chrome' ? chromeSteps() : webviewSteps()) {
        state.step = item;
        state.stepDialogs = [];
        state.pending = [];
        state.plans = [...item.plans];
        const before = snapshot();
        const sent = { id: item.id, label: item.label, kind: item.kind, instruction: instruction(item),
            ...(item.requests ? { requests: item.requests() } : {}),
            ...(item.first ? { first: item.first(), second: item.second() } : {}) };
        say(`${item.id} ${item.label}`);
        say(`  ${sent.instruction}`);
        publish({ step: sent });
        const result = await resultOf(item.id);
        await Promise.all(state.pending);
        release(state.dialogWaiters, { visible: false, released: 'step ended' });
        release(state.releaseWaiters, { released: 'step ended' });
        let checks;
        try { checks = toChecks(item.verify(result, { dialogs: state.stepDialogs, before })); } catch (error) { checks = toChecks([['the step checks ran', false, error.message]]); }
        report.steps.push({ id: item.id, label: item.label, plans: item.plans, sent, result: item.keep ? item.keep(result) : result,
            records_before: before, records_after: snapshot(), dialogs: state.stepDialogs, checks });
        for (const failed of checks.filter(entry => !entry.pass)) say(`  FAIL ${failed.name}`);
        say(`  ${checks.filter(entry => entry.pass).length}/${checks.length} checks passed`);
    }
    publish({ done: true });
    report.end = await resultOf('end', GUARDS.page_end_ms).catch(error => ({ error: error.message }));
    report.console_at_end = { at: iso(), ...(await probe('session')), idle_ms: await idleMs() };
    finish(null);
}

main().catch(error => {
    say(`error: ${error.message}`);
    finish(error);
});
