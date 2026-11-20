/**
 * Per-action native confirmation for decisions made through the local
 * operator session (Robert's decision of 2026-11-20, Option A, task 5e513530).
 *
 * The local session (local-operator-session.js) keeps browsing, reading and
 * bootstrap click-free, but its cookie and origin-stored proof live in the
 * browser or webview, so any page JavaScript served from localhost:3000 can
 * use them, including a script an executor added to dashboard/src. A session
 * alone therefore no longer sends mail or records a document decision. Sending
 * an email (approve_send on both mail surfaces) and every document decision
 * (approve, request changes, and finishing a review with the
 * approve-after-changes grant or with decision answers) made through the
 * local session waits, inside the same HTTP request, for a native macOS
 * dialog that the API process itself shows with /usr/bin/osascript, outside
 * the browser and any webview. The dialog text is built only from server
 * records and names the exact action and subject. No client can produce,
 * carry or replay the answer: there is no token, header or body field for it.
 * Each confirmation is bound to one canonical action identity and is consumed
 * once by the write it authorizes; a retry asks again. The ruling covers sends
 * and document decisions only: other operator actions that accept the local
 * session (automatic-start, skill candidates, project, labeling and chat
 * routes) keep the parent behavior and are not asked.
 *
 * Declined, timed out, unavailable (not macOS, or osascript failed), busy (one
 * dialog at a time), paused (three declined, unanswered or abandoned dialogs
 * within ten minutes) or aborted (the client went away, before or during the
 * dialog) all refuse with a reason and record nothing. There is
 * no fallback. A verified Cloudflare Access session (tunnel browser, phone
 * shell, travel shell) and the operator bearer are separate credentials and
 * are not asked. An authority result that does not say which path it came
 * from is refused (fail closed).
 *
 * Limits: the dialog proves a click on a native window, not who clicked. A
 * process of the same macOS user that holds the Accessibility permission could
 * press it, and a same-user process can read the operator key file directly.
 * See docs/contracts/local-operator-session.md, "Per-action confirmation".
 */
const { execFile } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');

const OSASCRIPT = '/usr/bin/osascript';
const WAIT_SECONDS = 120;
// A confirmed answer authorizes only a write that follows it promptly.
const CONSUME_WITHIN_MS = 60 * 1000;
// Repeated prompts Robert did not ask for must not train him to click.
const PAUSE_AFTER = 3;
const PAUSE_WINDOW_MS = 10 * 60 * 1000;
const PAUSE_MS = 5 * 60 * 1000;
// Upper bound on dialog text. Each action's excerpts are shorter, so only an
// unusually long recipient or answer list reaches it.
const MESSAGE_MAX = 4000;
// Paths that carry their own operator credential and are never asked.
const NOT_ASKED = new Set(['access_session', 'operator_bearer', 'document_executor_bearer']);
const DEVICES = { 'mac-chrome': 'Google Chrome', 'mac-desktop': 'The Nexus app' };

// argv keeps every server string out of the script source (no injection).
// Cancel is the default button, so Return or Escape never confirms.
const SCRIPT = [
    'on run argv',
    '  set theTitle to item 1 of argv',
    '  set theMessage to item 2 of argv',
    '  set confirmLabel to item 3 of argv',
    '  set waitSeconds to (item 4 of argv) as integer',
    '  activate',
    '  try',
    '    set answer to display dialog theMessage with title theTitle buttons {"Cancel", confirmLabel} default button "Cancel" cancel button "Cancel" with icon caution giving up after waitSeconds',
    '  on error number -128',
    '    return "declined"',
    '  end try',
    '  if gave up of answer then return "timeout"',
    '  if button returned of answer is confirmLabel then return "confirmed"',
    '  return "declined"',
    'end run',
];

const REFUSALS = {
    declined: [403, 'operator_confirmation_declined', 'You declined the confirmation on this Mac. Nothing was recorded.'],
    timeout: [403, 'operator_confirmation_timeout', 'The confirmation on this Mac was not answered in time. Nothing was recorded.'],
    unavailable: [503, 'operator_confirmation_unavailable', 'The confirmation dialog could not be shown on this Mac. Nothing was recorded.'],
    busy: [409, 'operator_confirmation_busy', 'Another confirmation dialog is already open on this Mac; answer it first. Nothing was recorded.'],
    paused: [429, 'operator_confirmation_paused', 'Confirmations on this Mac are paused for five minutes after three were declined, left unanswered or abandoned within ten minutes. Nothing was recorded.'],
    aborted: [409, 'operator_confirmation_aborted', 'The request ended before the confirmation was answered. Nothing was recorded.'],
    unverified: [503, 'operator_confirmation_unavailable', 'This decision path cannot be confirmed, so nothing was recorded.'],
    mismatch: [409, 'operator_confirmation_mismatch', 'What would be recorded no longer matches what you confirmed. Nothing was recorded; reload and try again.'],
};

function refusal(reason, extra = {}) {
    const [status, code, error] = REFUSALS[reason] || REFUSALS.unavailable;
    return { ok: false, status, code, error, nothing_recorded: true, ...extra };
}

/** Stable JSON (sorted keys, undefined dropped) so one action has one key. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
            .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}
const identityKey = identity => createHash('sha256').update(canonical(identity), 'utf8').digest('hex');
const sha256 = value => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');

// Control, bidirectional-override and zero-width characters could disguise a
// recipient or subject in the dialog; they are removed from dialog text only.
// Code point ranges (kept numeric so no literal invisible character is in source).
const INVISIBLE = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x180e, 0x180e],
    [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const invisible = code => INVISIBLE.some(([low, high]) => code >= low && code <= high);
function clean(value) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
    return Array.from(text).filter(char => !invisible(char.codePointAt(0))).join('');
}
function oneLine(value, max = 300) {
    const flat = clean(value).replace(/\s*\n\s*/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)} [${flat.length - max} more characters]` : flat;
}
/** A labelled excerpt that always says how much of the text it shows. */
function excerpt(label, value, max) {
    const text = clean(value).trim();
    if (!text) return [];
    if (text.length <= max) return [`${label}:`, text];
    return [`${label} (first ${max} of ${text.length} characters; the rest is in Nexus):`, `${text.slice(0, max)} [...]`];
}
const omitted = count => `\n[${count} more characters of this request are not shown here; Nexus shows all of it]`;
/** Cut `text` to at most `max` characters, saying exactly how many were left out. */
function shorten(text, max) {
    if (text.length <= max) return text;
    // The note for the full length is never shorter than the note actually used.
    let keep = Math.max(0, max - omitted(text.length).length);
    if (keep > 0 && /[\uD800-\uDBFF]/.test(text[keep - 1])) keep -= 1; // never split a surrogate pair
    return `${text.slice(0, keep)}${omitted(text.length - keep)}`;
}

function showMacDialog({ title, message, confirmLabel, seconds, signal, run = execFile, platform = process.platform }) {
    if (platform !== 'darwin') return Promise.resolve('unavailable');
    return new Promise(resolve => {
        run(OSASCRIPT, [...SCRIPT.flatMap(line => ['-e', line]), title, message, confirmLabel, String(seconds)], {
            encoding: 'utf8', timeout: (seconds + 15) * 1000, maxBuffer: 64 * 1024, signal,
            // Do not inherit executor-controlled loader or tool-search settings.
            env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        }, (error, stdout) => {
            if (signal?.aborted) return resolve('aborted');
            if (error) return resolve(error.killed ? 'timeout' : 'unavailable');
            const answer = String(stdout || '').trim();
            return resolve(['confirmed', 'declined', 'timeout'].includes(answer) ? answer : 'unavailable');
        });
    });
}

// `origin` only labels the dialog; the live-check harness passes its own port.
function createOperatorConfirmations({ show = showMacDialog, seconds = WAIT_SECONDS, now = Date.now, log = console, origin = 'localhost:3000' } = {}) {
    let open = null;
    let unanswered = [];
    let pausedUntil = 0;

    function message(action, auth, ref) {
        const time = new Date(now()).toLocaleTimeString('en-US', { hour12: false });
        const device = DEVICES[auth?.device] || 'a local application';
        const body = action.lines.filter(line => line !== null && line !== undefined).join('\n');
        // Added after any cut, so who asked, the warning and the Ref always show
        // (after a blank line).
        const footer = `\n\n${[
            `Requested by ${device} on ${origin} at ${time}.`,
            'If you did not just ask for this in Nexus, click Cancel.',
            `Ref ${ref}`,
        ].join('\n')}`;
        return `${shorten(body, MESSAGE_MAX - footer.length)}${footer}`;
    }

    /**
     * Ask Robert, inside this request, to confirm `action`
     * ({ kind, identity, title, confirmLabel, lines }). Resolves to
     * { ok: true, required, ref, consume(identity) } or a refusal.
     */
    async function confirm({ res, auth, action }) {
        if (NOT_ASKED.has(auth?.via)) return { ok: true, required: false, ref: null, consume: () => true };
        if (auth?.via !== 'local_session') return refusal('unverified');
        // A client that left before the dialog would open (during a capture or
        // a Praxis read) is not asked at all; this does not count toward the pause.
        if (res?.destroyed || res?.socket?.destroyed) {
            log.log?.(`[OperatorConfirmation] aborted ${action.kind} before asking device=${auth?.device || 'unknown'}`);
            return refusal('aborted');
        }
        if (now() < pausedUntil) return refusal('paused');
        if (open) return refusal('busy');
        const ref = randomBytes(4).toString('hex');
        const key = identityKey(action.identity);
        const controller = new AbortController();
        const gone = () => { if (!res?.writableEnded) controller.abort(); };
        res?.on?.('close', gone);
        open = { ref, kind: action.kind };
        let outcome;
        try {
            outcome = await show({
                title: oneLine(action.title, 120),
                message: message(action, auth, ref),
                confirmLabel: oneLine(action.confirmLabel, 40),
                seconds,
                signal: controller.signal,
            });
        } catch {
            outcome = 'unavailable';
        } finally {
            open = null;
            res?.off?.('close', gone);
        }
        if (controller.signal.aborted) outcome = 'aborted';
        if (!REFUSALS[outcome] && outcome !== 'confirmed') outcome = 'unavailable';
        if (outcome === 'confirmed') unanswered = [];
        else if (['declined', 'timeout', 'aborted'].includes(outcome)) {
            unanswered = unanswered.filter(at => now() - at < PAUSE_WINDOW_MS).concat(now());
            if (unanswered.length >= PAUSE_AFTER) {
                pausedUntil = now() + PAUSE_MS;
                unanswered = [];
            }
        }
        log.log?.(`[OperatorConfirmation] ${outcome} ${action.kind} ref=${ref} device=${auth?.device || 'unknown'}`);
        if (outcome !== 'confirmed') return refusal(outcome, { confirmation_ref: ref });
        const confirmedAt = now();
        let used = false;
        return {
            ok: true, required: true, ref,
            /** Single use, within the window, and only for the identity confirmed. */
            consume(identity) {
                if (used || now() - confirmedAt > CONSUME_WITHIN_MS) return false;
                used = true;
                return identityKey(identity) === key;
            },
        };
    }

    return { confirm, status: () => ({ open: open ? { ...open } : null, pausedUntil }) };
}

// ── Dialog wording, built only from server records ─────────────────────────

function mailSendAction({ identity, to, cc, subject, body, html }) {
    const hasHtml = typeof html === 'string' && html.trim() !== '';
    return {
        kind: 'mail_send', identity, title: 'Nexus: send this email?', confirmLabel: 'Send',
        lines: [
            `Send to ${oneLine(to, 320)}: "${oneLine(subject, 300)}"?`,
            `Cc: ${Array.isArray(cc) && cc.length ? cc.map(address => oneLine(address, 320)).join(', ') : 'none'}`,
            // Mail apps usually show the HTML part, which the dialog cannot render.
            hasHtml ? `This email also has an HTML part (${html.length} characters). Most mail apps show that part instead of the text below; the draft in Nexus shows it.` : null,
            '',
            ...excerpt('Message', body, 800),
        ],
    };
}

function documentDecisionAction({ identity, title, revision, version, decision, direction, note }) {
    const approve = decision === 'approve';
    return {
        kind: 'document_decision', identity,
        title: approve ? 'Nexus: approve this document?' : 'Nexus: request changes?',
        confirmLabel: approve ? 'Approve' : 'Request changes',
        lines: [
            `${approve ? 'Approve' : 'Request changes to'} "${oneLine(title, 200)}"?`,
            `${version ? `Version ${version}, r` : 'R'}evision ${oneLine(revision.id, 120)}, content sha256 ${String(revision.content_hash || '').slice(0, 12)}, captured ${oneLine(revision.captured_at || 'unknown', 40)}${revision.edited_by ? `, edited by ${oneLine(revision.edited_by, 80)}` : ''}.`,
            direction ? `Direction: ${oneLine(direction, 200)}` : null,
            ...excerpt('Note', note, 400),
        ],
    };
}

function reviewFinishAction({ identity, title, revisionId, version, delegated, answers, summary, commentCount }) {
    return {
        kind: 'review_finish', identity,
        title: 'Nexus: finish this review?',
        confirmLabel: delegated ? 'Approve after changes' : 'Send answers',
        lines: [
            `Finish your review of "${oneLine(title, 200)}" (${version ? `version ${version}, ` : ''}revision ${oneLine(revisionId, 120)})?`,
            delegated ? 'This lets the executor that applies your changes record your approval of the revised version.' : null,
            answers.length ? `Decision answers (${answers.length}):` : null,
            ...answers.map(answer => `- ${oneLine(answer.question, 160)}: ${oneLine(answer.label, 200)}`),
            `Comments in this review: ${commentCount}.`,
            ...excerpt('Summary', summary, 400),
        ],
    };
}

const operatorConfirmations = createOperatorConfirmations();

module.exports = {
    createOperatorConfirmations, operatorConfirmations, showMacDialog, identityKey, canonical, sha256,
    mailSendAction, documentDecisionAction, reviewFinishAction, SCRIPT, REFUSALS, NOT_ASKED,
};
