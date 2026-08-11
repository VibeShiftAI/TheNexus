/**
 * Antigravity CLI (agy) one-shot client — subscription-authed Gemini
 * completions with no per-token Gemini API spend.
 *
 * Mirrors Praxis's council seat runner (Praxis/src/council/cli-seat.ts),
 * which is the battle-tested reference for driving agy non-interactively:
 *   - The prompt travels in ARGV (`agy -p <prompt>`); stdin is closed.
 *   - `--print-timeout` is agy's own ceiling (Go duration syntax); a backstop
 *     timer kills the process GROUP — agy spawns a language-server child that
 *     would otherwise hold the stdio pipes open past agy's own death.
 *   - `--log-file` pins agy's diagnostic log to a temp path we own, so the
 *     startup probe reads THIS run's file. agy startup wedges often enough to
 *     matter: if the log is still empty after the probe window, kill and
 *     retry once.
 *   - agy transcripts echo the prompt back into stdout — the reply is
 *     whatever follows the LAST occurrence of the echoed prompt.
 */

const { spawn } = require('child_process');
const { existsSync, mkdtempSync, rmSync, readFileSync, statSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

const AGY_BREW_BIN = '/opt/homebrew/bin/agy';
const DEFAULT_TIMEOUT_MS = 240000;
const STARTUP_PROBE_MS = 30000;
const KILL_GRACE_MS = 5000;

function resolveAgyBin() {
    if (process.env.AGY_BIN && existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
    if (existsSync(AGY_BREW_BIN)) return AGY_BREW_BIN;
    return 'agy'; // rely on PATH; spawn errors surface as { ok: false }
}

/** Kill agy AND its language server: agy is spawned detached, so it leads its own group. */
function killAgyTree(child) {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ }
    }, KILL_GRACE_MS).unref();
}

function runAgyOnce(prompt, { timeoutMs, model, cwd }) {
    return new Promise((resolve) => {
        let logDir;
        try {
            logDir = mkdtempSync(path.join(tmpdir(), 'nexus-agy-'));
        } catch (err) {
            resolve({ ok: false, error: `agy temp dir failed: ${err.message}` });
            return;
        }
        const logFile = path.join(logDir, 'cli.log');
        const args = ['-p', prompt, '--log-file', logFile, '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`];
        if (model) args.push('--model', model);

        let child;
        try {
            child = spawn(resolveAgyBin(), args, { cwd: cwd || tmpdir(), env: process.env, detached: true });
        } catch (err) {
            rmSync(logDir, { recursive: true, force: true });
            resolve({ ok: false, error: `agy spawn failed: ${err.message}` });
            return;
        }

        let output = '';
        let settled = false;
        // Settle on the KILL, not on `close`: `close` waits for every inherited
        // stdio pipe to reach EOF, and a surviving language server holds them open.
        const settle = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(startupTimer);
            rmSync(logDir, { recursive: true, force: true });
            resolve(result);
        };

        const timer = setTimeout(() => {
            killAgyTree(child);
            settle({ ok: false, error: `agy timed out after ${timeoutMs}ms`, output });
        }, timeoutMs + 10000);
        const startupTimer = setTimeout(() => {
            let wroteLog = false;
            try { wroteLog = statSync(logFile).size > 0; } catch { /* never created */ }
            if (!wroteLog) {
                killAgyTree(child);
                settle({ ok: false, startupStalled: true, error: 'agy startup wedged (no log output)', output });
            }
        }, STARTUP_PROBE_MS);
        timer.unref();
        startupTimer.unref();

        child.stdout?.on('data', (chunk) => (output += chunk.toString()));
        child.stderr?.on('data', (chunk) => (output += chunk.toString()));
        child.stdin?.end(); // agy reads the prompt from argv; nothing goes to stdin

        child.on('error', (err) => settle({ ok: false, error: `agy error: ${err.message}`, output }));
        child.on('close', (code) => {
            if (code !== 0) {
                settle({ ok: false, error: `agy exited with code ${code}`, output });
                return;
            }
            // Strip the echoed prompt so protocol text inside it can't be
            // mistaken for the reply.
            const echoEnd = output.lastIndexOf(prompt);
            const text = (echoEnd === -1 ? output : output.slice(echoEnd + prompt.length)).trim();
            if (!text) {
                settle({ ok: false, error: 'agy completed with no output', output });
                return;
            }
            settle({ ok: true, text });
        });
    });
}

/**
 * One completion through the Antigravity CLI. Never throws.
 *
 * No `--model` is passed by default: agy's own default is a Gemini model, and
 * slug ids like "gemini-2.5-flash" silently fall back to that default anyway —
 * agy only pins on its display names ("Gemini 3.1 Pro (High)"). Set
 * NEXUS_AGY_MODEL to such a display name to pin.
 *
 * @returns {Promise<{ok: true, text: string} | {ok: false, error: string, output?: string}>}
 */
async function runAgyPrompt(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, model, cwd } = {}) {
    const pinned = model || process.env.NEXUS_AGY_MODEL || undefined;
    const first = await runAgyOnce(prompt, { timeoutMs, model: pinned, cwd });
    if (!first.startupStalled) return first;
    console.warn('[agy-client] agy startup wedged — retrying once');
    return runAgyOnce(prompt, { timeoutMs, model: pinned, cwd });
}

/** The outermost JSON array/object substring of a reply (handles code fences and prose), or null. */
function extractJsonSlice(raw) {
    const text = (raw || '').trim();
    if (!text) return null;
    const arrStart = text.indexOf('[');
    const objStart = text.indexOf('{');
    const start = arrStart === -1 ? objStart : objStart === -1 ? arrStart : Math.min(arrStart, objStart);
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start === -1 || end <= start) return null;
    return text.slice(start, end + 1);
}

module.exports = { runAgyPrompt, extractJsonSlice, resolveAgyBin };
