/**
 * The Groundrules anchor rule, ported for immediate feedback.
 *
 * Groundrules.club/src/ledger/corpus.py `anchor()` resolves a label quote by
 * joining its whitespace-separated words with `\s+`, requiring the match not
 * to end inside a word (`(?!\w)`), and demanding exactly one match inside the
 * `within` window (the row text for a row label, the context span for a
 * context label). Python's `finditer(text, pos, endpos)` treats `endpos` as the
 * end of the string, so the trailing look-ahead sees nothing past the window;
 * slicing the window here reproduces that.
 *
 * This port is for field errors while Robert types. The scorer remains the
 * authority: every export is checked again by `python3 -m src.ledger goldset`
 * (see export.js and the round-trip test).
 */

const WORD_CHAR = '[\\p{L}\\p{N}_]';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Words of a quote the way Python's `str.split()` sees them. */
function words(quote) {
    return typeof quote === 'string' ? quote.split(/\s+/u).filter(Boolean) : [];
}

function pattern(quote) {
    const parts = words(quote);
    if (!parts.length) return null;
    return new RegExp(`${parts.map(escapeRegExp).join('\\s+')}(?!${WORD_CHAR})`, 'gu');
}

/**
 * Resolve `quote` inside `text`, optionally inside the unique span of
 * `within`. Returns `{ ok, count, start, end, slice, reason }` where offsets
 * are code-unit indices into `text` (only the slice is used by callers that
 * need the exact words).
 */
function resolveQuote(text, quote, within = null) {
    if (typeof text !== 'string') return { ok: false, count: 0, reason: 'no_text' };
    if (!words(quote).length) return { ok: false, count: 0, reason: 'empty' };
    let lower = 0;
    let upper = text.length;
    if (within !== null && within !== undefined && within !== '') {
        const window = resolveQuote(text, within, null);
        if (!window.ok) return { ok: false, count: 0, reason: window.count === 0 ? 'within_not_found' : 'within_not_unique' };
        lower = window.start;
        upper = window.end;
    }
    const windowText = text.slice(lower, upper);
    const re = pattern(quote);
    const matches = [];
    let match;
    while ((match = re.exec(windowText)) !== null) {
        matches.push({ start: lower + match.index, end: lower + match.index + match[0].length });
        if (match[0].length === 0) re.lastIndex += 1;
    }
    if (matches.length === 1) {
        const { start, end } = matches[0];
        return { ok: true, count: 1, start, end, slice: text.slice(start, end) };
    }
    return { ok: false, count: matches.length, reason: matches.length === 0 ? 'not_found' : 'not_unique' };
}

/** Human wording for a failed resolution, shared by the API and the form. */
function describeQuoteFailure(result) {
    switch (result.reason) {
        case 'empty': return 'Quote the exact words from the passage.';
        case 'not_found': return 'These words do not occur in the passage as written. Copy them exactly; spacing does not matter, but the quote must end at a word boundary.';
        case 'not_unique': return `These words occur ${result.count} times in the passage. Quote a longer span, or name a unique surrounding span under "within".`;
        case 'within_not_found': return 'The "within" span does not occur in the passage.';
        case 'within_not_unique': return 'The "within" span occurs more than once in the passage; make it longer.';
        case 'no_text': return 'No passage text to match against.';
        default: return 'The quote could not be resolved.';
    }
}

module.exports = { resolveQuote, describeQuoteFailure, words };
