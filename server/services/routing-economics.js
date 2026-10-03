const { estimateRunCostUsdRaw, usageUnknownReason } = require('./run-cost');
const { isTerminalOutcome } = require('./run-trace');

const LOCAL = new Set(['local', 'ollama', 'lmstudio', 'lm-studio', 'mlx', 'llama.cpp']);
const CLOUD = new Set(['claude-code', 'codex', 'antigravity', 'openrouter', 'anthropic', 'openai', 'google', 'gemini', 'xai']);
const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const normalized = value => String(value || '').trim().toLowerCase();

function providerLane(provider) {
    const name = normalized(provider);
    return LOCAL.has(name) ? 'local' : CLOUD.has(name) ? 'cloud' : 'unknown';
}

function laneFor(row, models) {
    // A CLI running on this computer can still call a cloud model. Prefer
    // the recorded executor over today's registry, which may have changed.
    const executorLane = providerLane(row.executor);
    if (executorLane !== 'unknown') return executorLane;
    const providers = models.filter(m => m.id === row.model || m.api_model_id === row.model)
        .map(m => providerLane(m.provider));
    return providers.length && providers.every(lane => lane === providers[0]) ? providers[0] : 'unknown';
}

function summarize(rows, identity) {
    const durations = [];
    let tokens = 0, tokenRuns = 0, estimatedTokenRuns = 0, usd = 0, costRuns = 0;
    const unknownByReason = {};
    const outcomes = { completed: 0, failed: 0, needsInput: 0, cancelled: 0, unfinished: 0, runs: 0, completionRate: null };
    for (const row of rows) {
        const terminal = isTerminalOutcome(row.outcome);
        const start = row.started_at ? Date.parse(row.started_at) : NaN;
        const end = row.completed_at ? Date.parse(row.completed_at) : NaN;
        if (terminal && Number.isFinite(start) && Number.isFinite(end) && end >= start) durations.push(end - start);
        if (validNumber(row.tokens)) {
            tokens += row.tokens;
            tokenRuns++;
            if (row.tokens_estimated) estimatedTokenRuns++;
        }
        const reason = identity.lane === 'local' ? null : identity.lane === 'unknown' ? 'unknown_lane' : usageUnknownReason(row.tokens, row.model);
        if (reason) unknownByReason[reason] = (unknownByReason[reason] || 0) + 1;
        else {
            usd += identity.lane === 'local' ? 0 : estimateRunCostUsdRaw(row.tokens, row.model);
            costRuns++;
        }
        if (terminal) {
            outcomes.runs++;
            switch (normalized(row.outcome)) {
                case 'success': outcomes.completed++; break;
                case 'failure': case 'timeout': outcomes.failed++; break;
                case 'needs_input': outcomes.needsInput++; break;
                case 'cancelled': outcomes.cancelled++; break;
            }
        } else outcomes.unfinished++;
    }
    if (outcomes.runs) outcomes.completionRate = outcomes.completed / outcomes.runs;
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    return {
        ...identity,
        state: rows.length ? 'observed' : 'no_data',
        runCount: rows.length,
        latency: {
            medianMs: durations.length ? (durations[middle] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : null,
            worstMs: durations.length ? durations[durations.length - 1] : null,
            runs: durations.length,
        },
        tokens: { total: tokenRuns ? tokens : null, runs: tokenRuns, estimatedRuns: estimatedTokenRuns },
        cost: {
            usd: costRuns ? Math.round(usd * 1000) / 1000 : null,
            provenance: !costRuns ? 'unknown' : identity.lane === 'local' ? 'local_zero' : 'estimated',
            runs: costRuns, estimatedRuns: identity.lane === 'cloud' ? costRuns : 0,
            meteredRuns: 0, unknownRuns: rows.length - costRuns, unknownByReason,
        },
        outcomes,
    };
}

function aggregateRoutingEconomics(rows, models = []) {
    const groups = new Map();
    const lanes = new Map([['local', []], ['cloud', []]]);
    const ensure = (model, lane) => {
        const key = JSON.stringify([model, lane]);
        if (!groups.has(key)) groups.set(key, { model, lane, rows: [] });
        return groups.get(key);
    };
    for (const row of rows) {
        const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null;
        const lane = laneFor(row, models);
        ensure(model, lane).rows.push(row);
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(row);
    }
    // Current active roster supplies the no-run models; it never invents runs.
    for (const model of models.filter(m => m.is_active)) {
        const lane = providerLane(model.provider);
        const name = model.api_model_id || model.id;
        if (![...groups.values()].some(g => g.lane === lane && (g.model === name || g.model === model.id))) ensure(name, lane);
    }
    return {
        scope: 'All recorded dispatch attempts; includes failures and follow-ups. Activity commits are not additional runs.',
        costBasis: 'Cloud costs are estimates using the cockpit static rate table and assumed token mix (85% cache read, 2% input, 8% cache write, 5% output). API-equivalent value, not subscription charges or provider bills; rates are not live. Local $0 covers provider inference fees only, excluding hardware and electricity. No metered cost telemetry is recorded.',
        outcomeBasis: 'Completion is executor-reported success among terminal attempts, not QA acceptance or a task-difficulty-adjusted quality score. Unfinished runs are excluded. Failed attempts remain in token and cost totals.',
        lanes: [...lanes].map(([lane, list]) => summarize(list, { lane })),
        models: [...groups.values()].map(({ model, lane, rows: list }) => ({
            ...summarize(list, { model, lane }),
            runs: [...list].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).map(r => ({
                id: r.id, taskId: r.task_id, executor: r.executor, outcome: r.outcome, startedAt: r.started_at,
                href: `/task/${encodeURIComponent(r.task_id)}#dispatch-${encodeURIComponent(r.id)}`,
            })),
        })).sort((a, b) => b.runCount - a.runCount || String(a.model).localeCompare(String(b.model))),
    };
}

module.exports = { aggregateRoutingEconomics };
