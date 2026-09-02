/**
 * Dispatch eligibility + containment state (the "why isn't it running" surface).
 *
 * The board shows WHAT is waiting; Praxis knows WHY it waits — but scatters
 * that answer across the dispatch-state snapshot (:54322/api/dispatch/state),
 * the run-events spine (~/.praxis-mind/cost_ledger.sqlite), and gates that
 * only speak up when a dispatch is attempted. This router assembles it into
 * three read surfaces plus the one control Praxis exposes:
 *
 *   GET  /api/dispatch-insight/eligibility → per waiting task (Ready/New
 *        lanes), the FIRST gate that blocks it — queued behind the CLI slot,
 *        incomplete predecessors, dormant project, suspended executor,
 *        machine-wide slot busy — or "eligible" when nothing does. Plus the
 *        containment summary: slot holder, queue, executor health, incidents.
 *   GET  /api/dispatch-insight/task/:taskId → per-run insight for the task
 *        screen's dispatch console: the effective wall-clock ceiling (the only
 *        ceiling Praxis enforces), elapsed vs ceiling, estimated cost,
 *        guardrail events (incidents + boot reconciliations), and the
 *        verification verdict from the run-events spine.
 *   POST /api/dispatch-insight/kill → a genuinely TARGETED kill: signal the
 *        run's own process group, identified by the pid in Praxis's
 *        detached-run record and verified against the live process table
 *        before any signal is sent (the same SIGTERM→SIGKILL shape as
 *        Praxis's own timeout enforcer, killRunGroup). Praxis's completion
 *        poller notices the death within seconds and does its own
 *        bookkeeping (callback → task.failed → slot freed → queue pump).
 *        Rows are closed only after the process is confirmed dead. No
 *        broad-brush Praxis tools are invoked — antigravity_abort performs
 *        GLOBAL presence/extension cleanup and matches only internal
 *        Antigravity dispatch ids, so it is never called here.
 *
 * Honesty rules (project end-state): Praxis unreachable is reported as
 * unknown, never as eligible; every cost figure and the assumed-default
 * ceiling are flagged as estimates. Same DB pattern as dispatches.js — the
 * injected facade has no raw SQL, so this module opens its own WAL handle.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const { isTaskDone } = require('@praxis/contract');
const { PRAXIS_URL } = require('../shared/constants');

const DEFAULT_DB_PATH = process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../../nexus.db');
// Praxis's durable run-lifecycle spine (run_events: dispatched/phase/finished/
// verification). Filename is historical — it holds no cost column.
const DEFAULT_SPINE_PATH = process.env.PRAXIS_EXECUTION_LOG_DB
    || path.join(os.homedir(), '.praxis-mind', 'cost_ledger.sqlite');
// Praxis's detached-run records: one <taskId>.json per LIVE run, carrying the
// ACTUAL resolved timeoutMs the timeout enforcer uses (deadline = startedAt +
// timeoutMs). Removed at finalization, so it is real telemetry for running
// rows only. See Praxis/src/executors/detached-run.ts (DetachedRunRecord).
const DEFAULT_DETACHED_RUNS_DIR = process.env.PRAXIS_DETACHED_RUNS_DIR
    || '/Volumes/Projects/Praxis/data/detached-runs';

const PRAXIS_TIMEOUT_MS = 4_000;
// SIGTERM → grace → SIGKILL → grace, polling for process death throughout.
// Mirrors the escalation shape of Praxis's own timeout enforcer.
const KILL_GRACE_MS = 1_500;
const KILL_POLL_MS = 100;

// Praxis's only per-run ceiling is wall-clock. The Nexus board CANNOT know
// the true value for historical runs: task metadata.timeoutMs is never
// propagated into the ExecutionRequest for Nexus dispatches, and Praxis's
// PRAXIS_EXECUTOR_TIMEOUT_MS env override is invisible from here. So the
// ceiling is reported from the detached-run record when one exists (the
// enforcer's real number) and otherwise as this assumed default — mirrors
// Praxis/src/executors/executor-timeout.ts FALLBACK_DEFAULT_TIMEOUT_MS.
const DEFAULT_CEILING_MS = 3 * 60 * 60 * 1000;

// Reroute preference on a suspended executor, mirroring Praxis
// executors/index.ts REROUTE_PREFERENCE + planSuspendedDispatch: a suspended
// preferred worker re-routes to the first AVAILABLE one and only holds the
// task when none is.
const REROUTE_PREFERENCE = ['claude-code', 'codex', 'antigravity'];

// Praxis's machine-wide single-CLI-run gate counts these executors
// (run-registry CLI_EXECUTORS; antigravity is a member in its default CLI
// dispatch mode). Antigravity in legacy UI-bridge mode would be over-counted
// here — acceptable, that mode is retired in practice.
const CLI_EXECUTORS = new Set(['claude-code', 'codex', 'antigravity']);

// Lane mirror of dashboard/src/lib/task-board.ts — a task is "waiting" when it
// classifies into the New or Ready lane. Keep the sets in sync with that file.
const NEW_STATUSES = new Set(['idea', 'planning']);
const NON_WAITING_STATUSES = new Set([
    'building', 'in_progress', 'review', 'implementing', 'researching', 'scheduled', 'dispatched', 'ready_for_review',
    'blocked', 'suspended', 'failed', 'awaiting_approval', 'rejected', 'needs_input',
    'done', 'complete', 'completed',
    'cancelled', 'canceled',
    'archived',
]);
const DORMANT_PROJECT_STATUSES = new Set(['paused', 'parked']);

// Notional $/1M-token rates, mirrored from Praxis/src/usage/usage-monitor.ts
// PRICE_PER_MTOK (subscription families don't bill per token — this is the
// API-equivalent value of the work). Dispatch rows carry one total token
// count with no input/output split, so the estimate blends the two rates.
// `cacheRead` overrides the 10%-of-input cache-read default below for a model
// that prices cache reads differently (Fable 5.1 reads cache at $0.25/MTok —
// 2.5% of input, not 10% — mirrored from Praxis/src/usage/usage-monitor.ts).
const PRICE_PER_MTOK = {
    'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'gpt-5.6-sol': { in: 5, out: 30 },
    'gpt-5.6-terra': { in: 2.5, out: 15 },
    'gpt-5.6-luna': { in: 1, out: 6 },
    'gpt-5.5': { in: 1.25, out: 10 },
};
// A dispatch row carries ONE total token count, and for claude-code that
// total sums every usage category — including cache reads, which dominate
// agentic runs and are priced at 10% of input by default (cache writes at
// 125%). The blend assumes a typical CLI-run mix and applies Praxis's
// category pricing:
//   cache-read 85% · fresh input 2% · cache-write 8% · output 5%
// → effective $/MTok = in × (0.85×cacheReadRate + 0.02 + 0.08×1.25) + out × 0.05
//   where cacheReadRate = price.cacheRead / price.in when set, else 0.1
const BLEND = { cacheReadShare: 0.85, inputShare: 0.02, cacheWriteShare: 0.08, outputShare: 0.05 };

function priceFor(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return null;
    for (const [key, price] of Object.entries(PRICE_PER_MTOK)) {
        if (m.startsWith(key) || m.includes(key)) return price;
    }
    if (m.includes('opus')) return PRICE_PER_MTOK['claude-opus-5'];
    if (m.includes('sonnet')) return PRICE_PER_MTOK['claude-sonnet-5'];
    if (m.includes('fable') || m.includes('mythos')) return PRICE_PER_MTOK['claude-fable-5-1'];
    if (m.includes('haiku')) return PRICE_PER_MTOK['claude-haiku-4-5'];
    return null;
}

/** Cache-read $/MTok fraction of input — the model's own rate, else the 10% default. */
function cacheReadShareOfInput(price) {
    return typeof price.cacheRead === 'number' ? price.cacheRead / price.in : 0.1;
}

function estimateRunCostUsd(tokens, model) {
    if (typeof tokens !== 'number' || tokens <= 0) return null;
    const price = priceFor(model);
    if (!price) return null;
    const blended = price.in * (BLEND.cacheReadShare * cacheReadShareOfInput(price) + BLEND.inputShare + BLEND.cacheWriteShare * 1.25)
        + price.out * BLEND.outputShare;
    return Math.round((tokens / 1e6) * blended * 1000) / 1000;
}

function normalizeStatus(status) {
    return String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function parseJson(text, fallback) {
    if (typeof text !== 'string' || !text.trim()) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

function toTime(iso) {
    const t = new Date(iso || '').getTime();
    return Number.isFinite(t) ? t : null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The task's active run in a Praxis dispatch-state snapshot, if any. */
function activeRunFor(state, taskId) {
    const runs = state?.executors?.runs;
    return (Array.isArray(runs) ? runs : []).find(
        (r) => r?.taskId === taskId && r?.status === 'active',
    ) || null;
}

// ── Targeted process-kill helpers ────────────────────────────────────────
// The unit of life and death is the PROCESS GROUP, never the leader pid: a
// SIGTERM can kill the /bin/sh wrapper while a TERM-resistant CLI child in
// the same group survives, and a leader-only check would call that "dead".
// kill(-pgid, 0) succeeds while ANY member remains (EPERM counts as alive,
// mirroring Praxis detached-run.ts liveness semantics); pgid ≤ 1 is never a
// real detached run.
function isGroupAlive(pgid) {
    if (!Number.isInteger(pgid) || pgid <= 1) return false;
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

/**
 * Every live member of a process group with its command line. Filtered in JS
 * from the full table — `ps -g` flag semantics differ across BSD/GNU, and
 * this must not misread on either.
 */
function psGroupMembers(pgid) {
    return new Promise((resolve) => {
        execFile('ps', ['-axo', 'pgid=,pid=,command='], (err, stdout) => {
            if (err) return resolve([]);
            const members = [];
            for (const line of String(stdout).split('\n')) {
                const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
                if (m && Number(m[1]) === pgid) members.push({ pid: Number(m[2]), command: m[3] });
            }
            resolve(members);
        });
    });
}

/** Signal the whole process group, falling back to the bare pid — killRunGroup's shape. */
function killGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    } catch {
        try { process.kill(pid, signal); } catch { /* already dead */ }
    }
}

function createDispatchInsightRouter({
    dbPath = DEFAULT_DB_PATH,
    spineDbPath = DEFAULT_SPINE_PATH,
    detachedRunsDir = DEFAULT_DETACHED_RUNS_DIR,
    praxisUrl = PRAXIS_URL,
    fetchImpl = fetch,
    killWait = { graceMs: KILL_GRACE_MS, pollMs: KILL_POLL_MS },
} = {}) {
    const router = express.Router();

    let db;
    try {
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
    } catch (err) {
        console.error(`[DispatchInsight] DB unavailable (${err.message}) — insight disabled`);
        router.use((_req, res) => res.status(503).json({ error: 'dispatch insight storage unavailable' }));
        return router;
    }

    // Read-only, fail-soft handle on Praxis's run-events spine. The file
    // belongs to another process and may not exist (fresh machine, tests) —
    // every reader degrades to "spine unavailable" rather than erroring.
    let spineDb = null;
    function openSpine() {
        if (spineDb) return spineDb;
        try {
            if (!fs.existsSync(spineDbPath)) return null;
            spineDb = new Database(spineDbPath, { readonly: true });
            return spineDb;
        } catch (err) {
            console.warn(`[DispatchInsight] spine open failed (${err.message})`);
            return null;
        }
    }

    // Praxis's record for a task's LIVE detached run — the enforcer's real
    // ceiling plus the pid/bin the targeted kill needs — or null when no
    // record exists (finished runs delete theirs; fresh machines lack the
    // dir). taskId is externally supplied — reject anything path-like before
    // joining.
    function readDetachedRunRecord(taskId) {
        if (!/^[A-Za-z0-9_.-]+$/.test(taskId)) return null;
        try {
            const file = path.join(detachedRunsDir, `${taskId}.json`);
            if (!fs.existsSync(file)) return null;
            const rec = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (rec?.taskId !== taskId) return null;
            const ms = Number(rec.timeoutMs);
            if (!Number.isFinite(ms) || ms <= 0) return null;
            return {
                timeoutMs: Math.floor(ms),
                startedAt: rec.startedAt || null,
                pid: Number.isInteger(rec.pid) ? rec.pid : null,
                bin: typeof rec.bin === 'string' ? rec.bin : null,
                executor: typeof rec.executor === 'string' ? rec.executor : null,
            };
        } catch (err) {
            console.warn(`[DispatchInsight] detached-run record read failed (${err.message})`);
            return null;
        }
    }

    function spineRows(taskId) {
        const spine = openSpine();
        if (!spine) return null;
        try {
            return spine.prepare(`
                SELECT ts, type, phase, outcome, summary, data
                FROM run_events WHERE task_id = ? ORDER BY seq ASC
            `).all(taskId);
        } catch (err) {
            console.warn(`[DispatchInsight] spine read failed (${err.message})`);
            return null;
        }
    }

    // Both read endpoints need the Praxis snapshot and the console polls at
    // 6s while a run is live — share one in-flight/recent fetch so this
    // router doesn't multiply load on the daemon. Failures are never cached.
    const STATE_CACHE_MS = 3_000;
    let stateCache = { at: 0, promise: null };
    // `fresh` bypasses the cache — kill confirmation must see the registry as
    // it is NOW, not a 3s-old snapshot taken before the abort.
    function fetchDispatchState(fresh = false) {
        const now = Date.now();
        if (!fresh && stateCache.promise && now - stateCache.at < STATE_CACHE_MS) return stateCache.promise;
        const promise = (async () => {
            const res = await fetchImpl(`${praxisUrl}/api/dispatch/state`, {
                signal: AbortSignal.timeout(PRAXIS_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`Praxis dispatch-state HTTP ${res.status}`);
            return res.json();
        })();
        stateCache = { at: now, promise };
        promise.catch(() => {
            if (stateCache.promise === promise) stateCache = { at: 0, promise: null };
        });
        return promise;
    }

    /** Containment summary derived from a Praxis dispatch-state snapshot. */
    function containmentFrom(state) {
        const executors = state?.executors || {};
        const runs = Array.isArray(executors.runs) ? executors.runs : [];
        const activeCli = runs.filter((r) => r?.status === 'active' && CLI_EXECUTORS.has(r.executor));
        const holder = activeCli[0] || null;

        const queue = (Array.isArray(executors.cliQueue) ? executors.cliQueue : []).map((q, i) => ({
            taskId: q?.taskId || null,
            title: q?.title || null,
            executor: q?.executor || null,
            enqueuedAt: q?.enqueuedAt || null,
            position: i + 1,
        }));

        const now = Date.now();
        const health = [];
        for (const [name, s] of Object.entries(executors.health || {})) {
            const until = toTime(s?.suspendedUntil);
            health.push({
                name,
                strikes: s?.strikes ?? 0,
                suspended: until != null && until > now,
                suspendedUntil: s?.suspendedUntil || null,
                lastStrikeReason: s?.lastStrikeReason || null,
                lastRecoveredAt: s?.lastRecoveredAt || null,
            });
        }

        const incidents = [];
        for (const [name, list] of Object.entries(executors.incidents || {})) {
            for (const inc of Array.isArray(list) ? list : []) {
                incidents.push({ executor: name, at: inc?.at || null, label: inc?.label || 'unknown', reason: inc?.reason || null });
            }
        }
        incidents.sort((a, b) => String(b.at).localeCompare(String(a.at)));

        return {
            cliSlot: {
                busy: activeCli.length > 0,
                holder: holder && {
                    taskId: holder.taskId,
                    title: holder.title,
                    executor: holder.executor,
                    phase: holder.phase,
                    startedAt: holder.startedAt,
                },
            },
            queue,
            executors: health,
            incidents: incidents.slice(0, 10),
        };
    }

    // ─── Why waiting tasks are not running ───────────────────────────────
    router.get('/eligibility', async (_req, res) => {
        let rows;
        let statusById;
        try {
            rows = db.prepare(`
                SELECT t.id, t.project_id, t.name, t.status, t.priority, t.dependencies, t.default_executor,
                       p.name AS project_name, p.status AS project_status
                FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                WHERE t.archived_at IS NULL
            `).all();
            statusById = new Map(
                db.prepare('SELECT id, name, status FROM tasks').all().map((t) => [t.id, t]),
            );
        } catch (err) {
            console.error('[DispatchInsight] eligibility read failed:', err.message);
            return res.status(500).json({ error: 'Failed to read board: ' + err.message });
        }

        let state = null;
        let praxisError = null;
        try {
            state = await fetchDispatchState();
        } catch (err) {
            praxisError = err.message || 'Praxis unreachable';
        }
        const containment = state ? containmentFrom(state) : null;
        const queuedByTask = new Map((containment?.queue || []).map((q) => [q.taskId, q]));
        const suspendedByName = new Map(
            (containment?.executors || []).filter((e) => e.suspended).map((e) => [e.name, e]),
        );

        const tasks = [];
        for (const t of rows) {
            const status = normalizeStatus(t.status);
            if (NON_WAITING_STATUSES.has(status)) continue;
            const lane = NEW_STATUSES.has(status) ? 'new' : 'ready';

            // First blocking gate wins, checked in the order Praxis itself
            // would hit them; the queue check comes first because a queued
            // task has already PASSED the gates and will run when the slot
            // frees. `note` carries non-blocking context (e.g. a pending
            // executor reroute) alongside whatever reason applies.
            let reason = null;
            let note = null;
            const queued = queuedByTask.get(t.id);
            if (queued) {
                reason = {
                    code: 'queued',
                    detail: `Queued behind the active CLI run — position ${queued.position} of ${queuedByTask.size}.`,
                };
            }

            if (!reason) {
                const parsedDeps = parseJson(t.dependencies, []);
                const deps = Array.isArray(parsedDeps) ? parsedDeps : [];
                const incomplete = deps
                    .map((id) => statusById.get(id))
                    .filter((dep) => dep && !isTaskDone(dep.status));
                if (incomplete.length > 0) {
                    const list = incomplete.map((d) => `"${d.name}" (${normalizeStatus(d.status)})`).join(', ');
                    reason = {
                        code: 'predecessors_incomplete',
                        detail: `Waiting on ${incomplete.length} predecessor(s): ${list}.`,
                    };
                }
            }

            if (!reason && DORMANT_PROJECT_STATUSES.has(normalizeStatus(t.project_status))) {
                reason = {
                    code: 'project_dormant',
                    detail: `Project is ${normalizeStatus(t.project_status)} — the scheduler skips dormant projects (manual dispatch still works).`,
                };
            }

            if (!reason && containment) {
                // A suspended preferred executor is NOT a blocker on its own —
                // Praxis re-routes to the first available worker and only
                // holds the task when every circuit is open (mirrors
                // planSuspendedDispatch / pickRerouteExecutor in Praxis
                // executors/index.ts).
                const executor = t.default_executor || 'claude-code';
                const suspended = suspendedByName.get(executor);
                if (suspended) {
                    const rerouteTo = REROUTE_PREFERENCE.find(
                        (name) => name !== executor && !suspendedByName.has(name),
                    );
                    if (rerouteTo) {
                        note = `Preferred worker ${executor} suspended — Praxis reroutes this dispatch to ${rerouteTo}.`;
                    } else {
                        reason = {
                            code: 'executor_suspended',
                            detail: `Every worker's circuit is open (${executor}${suspended.suspendedUntil ? ` until ${suspended.suspendedUntil}` : ''}`
                                + `${suspended.lastStrikeReason ? ` — ${suspended.lastStrikeReason.slice(0, 140)}` : ''})`
                                + ' — Praxis holds the task at todo until one recovers.',
                        };
                    }
                }
                if (!reason && containment.cliSlot.busy) {
                    const h = containment.cliSlot.holder;
                    reason = {
                        code: 'cli_slot_busy',
                        detail: `Machine-wide CLI slot held by "${h?.title || h?.taskId}" (${h?.executor}, since ${h?.startedAt}).`,
                    };
                }
            }

            if (!reason && !containment) {
                reason = {
                    code: 'praxis_unreachable',
                    detail: 'Containment state unknown — Praxis (:54322) is unreachable, so eligibility cannot be confirmed.',
                };
            }

            tasks.push({
                taskId: t.id,
                name: t.name,
                projectId: t.project_id,
                projectName: t.project_name || null,
                status: t.status,
                priority: t.priority ?? 0,
                lane,
                eligible: reason === null,
                reason,
                note,
            });
        }

        res.json({
            at: new Date().toISOString(),
            praxis: { reachable: Boolean(state), error: praxisError },
            containment,
            tasks,
        });
    });

    // ─── Per-run insight for the dispatch console ────────────────────────
    router.get('/task/:taskId', async (req, res) => {
        const taskId = req.params.taskId;
        let dispatches;
        try {
            dispatches = db.prepare(`
                SELECT id, executor, model, tokens, tokens_estimated, outcome, started_at, completed_at
                FROM task_dispatches WHERE task_id = ?
                ORDER BY started_at DESC, created_at DESC LIMIT 50
            `).all(taskId);
        } catch (err) {
            console.error('[DispatchInsight] task read failed:', err.message);
            return res.status(500).json({ error: 'Failed to read task insight: ' + err.message });
        }

        // Ceilings are attributed PER RUN. The detached-run record is real
        // telemetry for exactly one run — the live one it describes — so its
        // ceiling lands only on the newest running row (matching executor
        // when the record names one); every other row, historical runs
        // included, gets the assumed default because its true ceiling was
        // never persisted. The board's task metadata is deliberately NOT
        // consulted — Praxis never propagates it into the execution request,
        // so it would be fiction.
        const hasRunningRow = dispatches.some((d) => d.outcome === 'running');
        const record = hasRunningRow ? readDetachedRunRecord(taskId) : null;
        // dispatches are newest-first, so the first matching running row is
        // the one the record describes.
        const recordRunId = record
            ? dispatches.find(
                (d) => d.outcome === 'running' && (!record.executor || d.executor === record.executor),
            )?.id ?? null
            : null;
        const DEFAULT_CEILING = { ms: DEFAULT_CEILING_MS, source: 'default_assumed' };
        // Task-level ceiling = what governs the live run (the strip's figure);
        // per-run values are attached to each row below.
        const ceiling = recordRunId
            ? { ms: record.timeoutMs, source: 'praxis_run_record' }
            : DEFAULT_CEILING;

        // Spine extras: verification verdicts, schedule estimate, boot
        // reconciliations. All fail-soft — spineAvailable tells the UI why a
        // verdict may be missing.
        const events = spineRows(taskId);
        const spineAvailable = events !== null;
        const verifications = [];
        const reconciliations = [];
        let scheduleEstimateMinutes = null;
        for (const ev of events || []) {
            const data = parseJson(ev.data, {});
            if (ev.type === 'verification') {
                verifications.push({
                    ts: ev.ts,
                    verdict: data?.verdict || ev.phase || 'unknown',
                    basis: Array.isArray(data?.basis) ? data.basis : (ev.summary ? [ev.summary] : []),
                    qa: data?.qa || null,
                    gates: data?.gates || null,
                });
            } else if (ev.type === 'dispatched' && Number.isFinite(Number(data?.estimated_minutes))) {
                scheduleEstimateMinutes = Number(data.estimated_minutes);
            } else if (ev.type === 'finished' && data?.reconciledAtBoot) {
                reconciliations.push({
                    at: ev.ts,
                    label: 'reconciled-at-boot',
                    source: 'run-registry',
                    detail: ev.summary || 'Praxis restarted while this run was in flight — marked failed.',
                });
            }
        }

        // Executor incidents (guardrail taxonomy) from Praxis — matched to a
        // run below by executor + time window, or by the task id appearing in
        // the incident reason.
        let incidents = [];
        let praxisReachable = true;
        try {
            const state = await fetchDispatchState();
            incidents = containmentFrom(state).incidents;
        } catch {
            praxisReachable = false;
        }

        const now = Date.now();
        const runs = dispatches.map((d) => {
            const started = toTime(d.started_at);
            const completed = toTime(d.completed_at);
            const end = completed ?? now;
            const elapsedMs = started != null && end >= started ? end - started : null;
            const running = d.outcome === 'running';

            const windowStart = started != null ? started - 60_000 : null;
            const windowEnd = end + 60_000;
            const guardrails = [
                ...incidents
                    .filter((inc) => {
                        if (inc.reason && inc.reason.includes(taskId)) return true;
                        if (inc.executor !== d.executor) return false;
                        const at = toTime(inc.at);
                        return at != null && windowStart != null && at >= windowStart && at <= windowEnd;
                    })
                    .map((inc) => ({ at: inc.at, label: inc.label, source: inc.executor, detail: inc.reason })),
                ...reconciliations.filter((r) => {
                    const at = toTime(r.at);
                    return at != null && windowStart != null && at >= windowStart && at <= windowEnd;
                }),
            ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

            // A verification record belongs to the latest run that started
            // before it was written (QA finalizes after the run completes).
            const verification = verifications.find((v) => {
                const ts = toTime(v.ts);
                if (ts == null || started == null || ts < started) return false;
                const newerRunStart = dispatches
                    .map((o) => toTime(o.started_at))
                    .filter((s) => s != null && s > started && s <= ts);
                return newerRunStart.length === 0;
            }) || null;

            // This row's own ceiling: the run record's real value only for
            // the row the record describes; the assumed default everywhere
            // else (a historical run's true ceiling was never persisted).
            const runCeiling = d.id === recordRunId
                ? { ms: record.timeoutMs, source: 'praxis_run_record' }
                : DEFAULT_CEILING;

            return {
                dispatchId: d.id,
                executor: d.executor,
                model: d.model,
                outcome: d.outcome,
                startedAt: d.started_at,
                completedAt: d.completed_at,
                elapsedMs,
                ceiling: runCeiling,
                overdue: running && elapsedMs != null && elapsedMs > runCeiling.ms,
                cost: (() => {
                    const usd = estimateRunCostUsd(d.tokens, d.model);
                    return usd != null ? { usd, estimated: true } : null;
                })(),
                verification,
                guardrails,
                canKill: running,
            };
        });

        res.json({
            taskId,
            ceiling,
            scheduleEstimateMinutes,
            spineAvailable,
            praxisReachable,
            latestVerification: verifications.length > 0 ? verifications[verifications.length - 1] : null,
            runs,
        });
    });

    // ─── Kill a running dispatch (targeted) ──────────────────────────────
    // The only honest kill is the one Praxis's own enforcer performs: signal
    // the run's process group, identified by the pid in its detached-run
    // record. The pid is verified against the live process table (the
    // command line must contain the record's bin path — guards pid reuse)
    // before any signal is sent, and rows are closed only after the process
    // is CONFIRMED dead. Praxis's completion poller observes the death and
    // does its own bookkeeping (task.failed → slot freed → queue pump).
    // Without a record there is nothing to target: a run the registry still
    // shows active is refused (409), and a ghost row (no record, no active
    // run) is closed as pure bookkeeping with no Praxis call at all.
    function closeRunningRows(taskId, note) {
        try {
            return db.prepare(`
                UPDATE task_dispatches SET
                    outcome = 'cancelled',
                    error = COALESCE(error, ?),
                    completed_at = ?,
                    updated_at = datetime('now')
                WHERE task_id = ? AND outcome = 'running'
            `).run(note, new Date().toISOString(), taskId).changes;
        } catch (err) {
            console.warn('[DispatchInsight] kill row-close failed:', err.message);
            return 0;
        }
    }

    async function waitForGroupDeath(pgid, graceMs, pollMs) {
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
            if (!isGroupAlive(pgid)) return true;
            await sleep(pollMs);
        }
        return !isGroupAlive(pgid);
    }

    router.post('/kill', async (req, res) => {
        const taskId = typeof req.body?.taskId === 'string' && req.body.taskId.trim()
            ? req.body.taskId.trim()
            : null;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const record = readDetachedRunRecord(taskId);
        // Group liveness, not leader liveness: a dead wrapper with a
        // surviving child still means the run is alive and killable.
        if (record && record.pid && isGroupAlive(record.pid)) {
            // Identity check across the WHOLE group: the wrapper's command
            // line embeds the record's CLI binary path and the CLI child's
            // argv starts with it, so a genuine run always has a matching
            // member. A recycled pgid won't — never signal a group we can't
            // positively identify. An empty listing while the group probes
            // alive (raced death / unlistable) also refuses: no blind kills.
            const members = await psGroupMembers(record.pid);
            const identified = record.bin && members.some((m) => m.command.includes(record.bin));
            if (!identified) {
                if (!isGroupAlive(record.pid)) {
                    // Died between the probe and the listing — fall through to
                    // the ghost/active bookkeeping below.
                } else {
                    const seen = members.map((m) => m.command).join(' | ').slice(0, 160);
                    return res.status(409).json({
                        ok: false,
                        cancelled: false,
                        error: `Refusing to kill: process group ${record.pid} no longer matches the run record (live members: "${seen || 'unlistable'}"). The pgid may have been recycled.`,
                    });
                }
            } else {
                killGroup(record.pid, 'SIGTERM');
                let method = 'sigterm';
                // Poll the GROUP: the leader dying while a TERM-resistant
                // child survives is not death. Whatever remains gets SIGKILL
                // before any row may close.
                let dead = await waitForGroupDeath(record.pid, killWait.graceMs, killWait.pollMs);
                if (!dead) {
                    killGroup(record.pid, 'SIGKILL');
                    method = 'sigkill';
                    dead = await waitForGroupDeath(record.pid, killWait.graceMs, killWait.pollMs);
                }
                if (!dead) {
                    const survivors = (await psGroupMembers(record.pid))
                        .map((m) => `${m.pid} ${m.command}`).join(' | ').slice(0, 160);
                    return res.status(502).json({
                        ok: false,
                        cancelled: false,
                        error: `SIGTERM and SIGKILL sent to process group ${record.pid} but members survive (${survivors || 'unlistable'}) — nothing was marked cancelled.`,
                    });
                }
                const closed = closeRunningRows(
                    taskId,
                    `Killed from the dispatch console (${method.toUpperCase()} to process group ${record.pid}, full group death confirmed). Praxis finalizes the run as failed when its poller observes the exit.`,
                );
                return res.json({ ok: true, cancelled: true, method, closedDispatches: closed });
            }
        }

        // No live process to target. Distinguish a ghost row (safe to close)
        // from a run Praxis still tracks as active (refuse — nothing targeted
        // exists to kill it with).
        let active;
        try {
            active = activeRunFor(await fetchDispatchState(true), taskId);
        } catch (err) {
            return res.status(502).json({
                error: `No live run record for this task and Praxis is unreachable (${err.message || 'unreachable'}) — cannot tell a ghost row from a live run, so nothing was touched.`,
            });
        }
        if (active) {
            return res.status(409).json({
                ok: false,
                cancelled: false,
                error: `Praxis reports an active ${active.executor} run for this task but no detached-run record exists to target — there is no safe kill primitive for it from here.`,
            });
        }
        const closed = closeRunningRows(
            taskId,
            'Closed from the dispatch console — no process, no run record, and no active run in the Praxis registry (ghost row left by a crashed executor).',
        );
        res.json({ ok: true, cancelled: true, method: 'ghost_cleanup', closedDispatches: closed });
    });

    return router;
}

module.exports = createDispatchInsightRouter;
