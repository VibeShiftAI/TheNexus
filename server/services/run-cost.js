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
    // gpt-6-astra (codex roster leader since 2026-09-06) has NO row on
    // purpose: no public $/MTok was verifiable when it was added, and an
    // invented rate would silently mis-state spend. priceFor() returns null
    // for it (no key here is a prefix or substring of "gpt-6-astra"), so its
    // runs report cost: null — "unknown", never a $0 that under-reports.
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

// ── Missing-usage attribution ────────────────────────────────────────────
// A cost of null has several distinct causes, and collapsing them loses the
// one fact the reader needs: WHY this run carries no figure. A UI that simply
// omits the chip reports "no spend" and "no record" identically — the exact
// confusion that left a published cost ordering unresolved when 58 runs on an
// Anthropic account had no usage record (arXiv:2609.11987 §5.1). So classify
// the absence and let the surface say "unknown" with its reason.
const USAGE_UNKNOWN_REASONS = {
    no_model: 'No model was recorded for this run, so no rate applies.',
    unpriced_model: 'This model has no verified $/MTok rate — inventing one would mis-state spend.',
    no_token_record: 'This run left no usage record, so its token count is unknown.',
};

/**
 * Why a run has no cost figure — null when it HAS one.
 * Order matters: a run with neither a model nor tokens is reported against
 * the token gap, because that is the telemetry that went missing.
 */
function usageUnknownReason(tokens, model) {
    // A RECORDED ZERO is a measurement, not a gap. A run that reported 0
    // tokens has usage telemetry; filing it under 'no_token_record' would
    // hide a real datum behind the word reserved for absent ones, and drag
    // the task's coverage down as if the run had gone unmeasured. Only an
    // absent, non-finite or negative count is genuinely unknown.
    const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
    if (!hasTokens) return 'no_token_record';
    if (!String(model || '').trim()) return 'no_model';
    if (!priceFor(model)) return 'unpriced_model';
    return null;
}

/**
 * Blended $ estimate for one run, or null when the run cannot be priced.
 * The null condition is EXACTLY usageUnknownReason() returning a reason, so
 * the figure and the "why is this missing" label can never disagree: a run
 * shown as unknown always lacks a cost, and a priced run never carries a
 * reason. A priced run measured at 0 tokens costs $0.000, which is a real
 * measurement rather than the absence of one.
 */
function estimateRunCostUsdRaw(tokens, model) {
    if (usageUnknownReason(tokens, model)) return null;
    const price = priceFor(model);
    const blended = price.in * (BLEND.cacheReadShare * cacheReadShareOfInput(price) + BLEND.inputShare + BLEND.cacheWriteShare * 1.25)
        + price.out * BLEND.outputShare;
    return (tokens / 1e6) * blended;
}

/** Preserve existing per-run display precision; aggregates use the raw value. */
function estimateRunCostUsd(tokens, model) {
    const usd = estimateRunCostUsdRaw(tokens, model);
    return usd === null ? null : Math.round(usd * 1000) / 1000;
}

/**
 * Task-level cost roll-up with its own coverage, so an aggregate is never
 * read as complete. `estimatedUsd` sums ONLY the priced runs; `coverage` is
 * the fraction of runs that contributed to it. When nothing is priced the sum
 * is null rather than 0 (zero priced runs is not zero spend).
 *
 * `rows` MUST be the task's COMPLETE dispatch history, never the page the
 * console happens to render. Aggregating the page silently drops older runs
 * and then reports full coverage over whatever survived the limit, which is
 * the exact concealment this roll-up exists to prevent.
 */
function summarizeRunUsage(rows) {
    const unknownByReason = {};
    let pricedRuns = 0;
    let subtotal = 0;
    for (const row of rows) {
        const reason = usageUnknownReason(row.tokens, row.model);
        if (reason) {
            unknownByReason[reason] = (unknownByReason[reason] || 0) + 1;
            continue;
        }
        pricedRuns += 1;
        subtotal += estimateRunCostUsd(row.tokens, row.model);
    }
    const totalRuns = rows.length;
    return {
        totalRuns,
        pricedRuns,
        unknownRuns: totalRuns - pricedRuns,
        unknownByReason,
        // Every priced figure is a notional blended estimate, never a bill.
        estimatedUsd: pricedRuns > 0 ? Math.round(subtotal * 1000) / 1000 : null,
        estimated: true,
        coverage: totalRuns > 0 ? Math.round((pricedRuns / totalRuns) * 1000) / 1000 : null,
    };
}

module.exports = { estimateRunCostUsdRaw, estimateRunCostUsd, usageUnknownReason, summarizeRunUsage, USAGE_UNKNOWN_REASONS };
