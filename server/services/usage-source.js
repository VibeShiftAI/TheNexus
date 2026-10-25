/**
 * Where an attribution figure (a token count or a cost) came from.
 *
 * Every token or cost figure the cockpit's attribution surfaces return
 * carries one of these markers next to it, so the dashboard never has to
 * guess whether a bare number was measured, guessed, or filled in:
 *
 *   measured     the run's own usage record (Praxis-reported counts, an
 *                unprefixed `Tokens:` commit trailer).
 *   estimated    an approximation: the server's char/4 text-volume backfill
 *                (task_dispatches.tokens_estimated = 1), a `Tokens: ~N`
 *                trailer, or any $ figure (always a blended notional rate).
 *   unavailable  no usage record exists. The figure is null, never 0.
 *   unknown      a count exists but nothing records whether it was measured
 *                or estimated (a row whose tokens_estimated flag is NULL).
 *                Reported as its own state rather than guessed either way.
 *
 * Aggregates take the weakest source among the runs that contributed: one
 * estimated run makes the sum an estimate, and a sum with no contributing run
 * is unavailable rather than zero.
 */

const USAGE_SOURCES = Object.freeze(['measured', 'estimated', 'unavailable', 'unknown']);

function isFigure(n) {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Source of ONE token count.
 *
 * @param {number|null|undefined} tokens  The recorded count.
 * @param {boolean|number|null|undefined} estimatedFlag  The row's own
 *        estimate flag (tokens_estimated 0/1, or a boolean). null/undefined
 *        with a count present means the provenance was never recorded.
 */
function tokenSource(tokens, estimatedFlag) {
    if (!isFigure(tokens)) return 'unavailable';
    if (estimatedFlag === null || estimatedFlag === undefined) return 'unknown';
    return estimatedFlag === true || Number(estimatedFlag) === 1 ? 'estimated' : 'measured';
}

/**
 * Source of a SUM over several runs.
 *
 * @param {{counted: number, estimated?: number, unknown?: number}} counts
 *        counted   runs that contributed a figure to the sum
 *        estimated how many of those were estimates
 *        unknown   how many carried no provenance flag
 */
function aggregateTokenSource({ counted = 0, estimated = 0, unknown = 0 } = {}) {
    if (!(counted > 0)) return 'unavailable';
    if (estimated > 0) return 'estimated';
    if (unknown > 0) return 'unknown';
    return 'measured';
}

/** Source of a $ figure: every cockpit cost is a notional estimate, never a bill. */
function costSource(usd) {
    return isFigure(usd) ? 'estimated' : 'unavailable';
}

module.exports = { USAGE_SOURCES, tokenSource, aggregateTokenSource, costSource };
