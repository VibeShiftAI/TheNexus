/**
 * Answer shapes and completeness rules for the three packet stages.
 *
 * Two kinds of outcome are kept apart on purpose:
 *   - a malformed answer (wrong types, unknown enum values, oversized text)
 *     is refused outright (`shapeError`), because it could never be stored
 *     as anything meaningful;
 *   - an incomplete answer (a field still blank or UNKNOWN, a quote that does
 *     not resolve) is stored as a draft with its `errors` attached, and only
 *     the stage commit refuses it.
 *
 * The enums are the scorer's (Groundrules.club/src/ledger/goldset.py and
 * vpu.py): MODALITIES, CATEGORIES, VERDICTS per fixture form, ANSWERS for
 * Part C. `UNKNOWN` is the scorer's own sentinel for "could not settle", kept
 * distinct from a blank field (never touched) and from an explicitly empty
 * proposition list (`propositionsDeclared: 'none'`).
 */
const { resolveQuote, describeQuoteFailure } = require('./quotes');

const UNKNOWN = 'UNKNOWN';
const MODALITIES = ['may', 'shall', 'must-not', 'is'];
const CATEGORIES = ['condition', 'exception', 'negation'];
const VERDICTS = { single: ['accept', 'reject'], pair: ['equivalent', 'different'] };
const ANSWERS = { exampleOutcomeSame: ['yes', 'no'], meaning: ['same', 'different'] };
const STATES = ['draft', 'unsure', 'complete'];
const MAX_TEXT = 4000;
const MAX_PROPOSITIONS = 40;

class ShapeError extends Error {
    constructor(message, field) {
        super(message);
        this.status = 400;
        this.code = 'malformed_answer';
        this.field = field;
    }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function str(value, field, { max = MAX_TEXT } = {}) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new ShapeError(`${field} must be a string`, field);
    if (value.length > max) throw new ShapeError(`${field} is longer than ${max} characters`, field);
    return value;
}

function oneOf(value, allowed, field) {
    const text = str(value, field, { max: 64 });
    if (text === '' || text === UNKNOWN || allowed.includes(text)) return text;
    throw new ShapeError(`${field} must be one of ${allowed.join(', ')}, UNKNOWN, or blank`, field);
}

/** Which text a quote is taken from: the row itself or one of its contexts. */
function quoteSource(row, source, field) {
    if (source === undefined || source === null || source === '' || source === 'row') return { kind: 'row', text: row.text, index: null, anchorWithin: row.anchorWithin || null };
    const index = typeof source === 'number' ? source : Number.parseInt(String(source).replace(/^context:/, ''), 10);
    if (!Number.isInteger(index) || index < 0 || index >= row.contexts.length) throw new ShapeError(`${field} names a context the row does not have`, field);
    return { kind: 'context', text: row.contexts[index].quote, index, sourceUnit: row.contexts[index].sourceUnit, quotable: row.contexts[index].quotable !== false };
}

/**
 * The scorer resolves a user-supplied `within` in the whole source unit (the
 * section the row was cut from), not in the displayed passage, and needs it
 * to occur there exactly once (Groundrules.club/src/ledger/corpus.py anchor).
 * Returns a field error when the span would not resolve there, or when the
 * unit text cannot be read: an unverifiable anchor stays a draft rather than
 * reaching the scorer.
 */
function checkWithinInUnit(row, where, within, field, unitText) {
    const unit = where.kind === 'context' ? where.sourceUnit || row.sourceUnit : row.sourceUnit;
    const scope = typeof unitText === 'function' && row.sourceId && unit ? unitText(row.sourceId, unit) : { ok: false, reason: unit ? 'corpus_unavailable' : 'unit_unknown' };
    if (!scope.ok) {
        return { path: `${field}.within`, message: `"Within" cannot be checked against the section text the scorer resolves it in (${scope.reason}). Clear it and quote a longer span instead.`, reason: 'within_unverifiable', detail: scope.reason };
    }
    const found = resolveQuote(scope.text, within, null);
    if (found.ok) return null;
    if (found.count === 0) {
        return { path: `${field}.within`, message: 'These "within" words resolve in the passage but not in the full section text the scorer uses; copy them exactly as written there.', reason: 'within_not_found_in_unit', count: 0 };
    }
    return { path: `${field}.within`, message: `These "within" words occur ${found.count} times in the full section the scorer resolves them in (${unit}), so they cannot pin the quote. Widen "within" to a span that appears only once in the section.`, reason: 'within_not_unique_in_unit', count: found.count };
}

function checkQuote(row, quote, within, source, field, errors, { unitText } = {}) {
    const where = quoteSource(row, source, `${field}.source`);
    if (!quote.trim()) {
        errors.push({ path: `${field}.quote`, message: 'Quote the exact words from the passage.' });
        return null;
    }
    if (where.kind === 'context' && !where.quotable) {
        errors.push({ path: `${field}.source`, message: 'This context cannot be quoted: the roster does not list it. Quote from the row text instead.' });
        return null;
    }
    if (where.kind === 'row' && where.anchorWithin && within && within.trim()) {
        errors.push({ path: `${field}.within`, message: 'This passage repeats inside its section, so a narrower "within" cannot pin a quote for the scorer. Clear "within" and quote a longer span instead.', reason: 'within_not_allowed' });
        return null;
    }
    const result = resolveQuote(where.text, quote, within || null);
    if (!result.ok) {
        errors.push({ path: `${field}.quote`, message: describeQuoteFailure(result), reason: result.reason, count: result.count });
        return null;
    }
    if (where.kind === 'row' && where.anchorWithin) {
        // The scorer resolves this row's quotes inside the roster span, which
        // is wider than the passage; the quote has to be unique there too.
        const wide = resolveQuote(where.anchorWithin, quote, null);
        if (!wide.ok) {
            errors.push({
                path: `${field}.quote`,
                message: wide.count === 0
                    ? 'These words resolve in the passage but not in the section span the scorer uses for this row; copy them exactly as written.'
                    : `These words occur ${wide.count} times in the section span the scorer uses for this row (the passage repeats there). Quote a longer span.`,
                reason: wide.count === 0 ? 'not_found_in_section' : 'not_unique_in_section',
                count: wide.count,
            });
            return null;
        }
    }
    if (within && within.trim()) {
        // Same scope as the scorer: the exported `within` must be unique in
        // the whole unit, not only in the passage shown on screen.
        const unitError = checkWithinInUnit(row, where, within, field, unitText);
        if (unitError) {
            errors.push(unitError);
            return null;
        }
    }
    return { ...where, start: result.start, end: result.end, slice: result.slice };
}

function numericShape(value, field) {
    if (value === undefined || value === null || value === false) return null;
    if (!isPlainObject(value)) throw new ShapeError(`${field} must be an object with value, unit and operator`, field);
    const raw = value.value;
    let parsed = null;
    if (typeof raw === 'number') parsed = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') {
        if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) throw new ShapeError(`${field}.value must be a plain decimal number`, `${field}.value`);
        parsed = Number(raw.trim());
    } else if (raw !== '' && raw !== undefined && raw !== null) throw new ShapeError(`${field}.value must be a number`, `${field}.value`);
    const out = {
        value: parsed,
        unit: str(value.unit, `${field}.unit`, { max: 64 }).trim(),
        operator: str(value.operator, `${field}.operator`, { max: 32 }).trim(),
    };
    if (out.value !== null && !Number.isFinite(out.value)) throw new ShapeError(`${field}.value must be a number`, `${field}.value`);
    return out;
}

/**
 * Stage A: one row's independent reading.
 * Returns { answer, errors, complete } where `answer` is the normalized copy
 * that gets stored; throws ShapeError for input that cannot be stored.
 * `options.unitText(sourceId, unit)` is the packet's corpus accessor; without
 * it a user-supplied `within` cannot be verified and keeps the row a draft.
 */
function validateStageA(row, input, options = {}) {
    if (!isPlainObject(input)) throw new ShapeError('answer must be an object', 'answer');
    const errors = [];
    const modality = oneOf(input.modality, MODALITIES, 'modality');
    if (modality === '') errors.push({ path: 'modality', message: 'Choose the modality, or mark it UNKNOWN if you cannot settle it.' });
    else if (modality === UNKNOWN) errors.push({ path: 'modality', message: 'Marked UNKNOWN. The stage cannot be committed until it is settled.', unknown: true });

    const actorInput = isPlainObject(input.actor) ? input.actor : {};
    const actor = {
        quote: str(actorInput.quote, 'actor.quote'),
        source: actorInput.source === undefined || actorInput.source === null || actorInput.source === '' ? 'row' : actorInput.source,
        within: str(actorInput.within, 'actor.within'),
    };
    const actorSpan = checkQuote(row, actor.quote, actor.within, actor.source, 'actor', errors, options);

    const declared = oneOf(input.propositionsDeclared, ['none', 'some'], 'propositionsDeclared');
    if (!Array.isArray(input.propositions ?? [])) throw new ShapeError('propositions must be an array', 'propositions');
    const list = input.propositions ?? [];
    if (list.length > MAX_PROPOSITIONS) throw new ShapeError(`at most ${MAX_PROPOSITIONS} propositions per row`, 'propositions');
    const propositions = list.map((item, index) => {
        if (!isPlainObject(item)) throw new ShapeError(`propositions[${index}] must be an object`, `propositions[${index}]`);
        const field = `propositions[${index}]`;
        const category = oneOf(item.category, CATEGORIES, `${field}.category`);
        const prop = {
            id: str(item.id, `${field}.id`, { max: 80 }) || `p${index + 1}`,
            category,
            quote: str(item.quote, `${field}.quote`),
            source: item.source === undefined || item.source === null || item.source === '' ? 'row' : item.source,
            within: str(item.within, `${field}.within`),
            numeric: numericShape(item.numeric, `${field}.numeric`),
            note: str(item.note, `${field}.note`),
        };
        if (category === '') errors.push({ path: `${field}.category`, message: 'Choose condition, exception or negation.' });
        else if (category === UNKNOWN) errors.push({ path: `${field}.category`, message: 'Marked UNKNOWN; settle the category before committing.', unknown: true });
        const span = checkQuote(row, prop.quote, prop.within, prop.source, field, errors, options);
        if (span) prop.resolved = { source: span.kind, index: span.index, start: span.start, end: span.end, slice: span.slice };
        if (prop.numeric) {
            if (prop.numeric.value === null) errors.push({ path: `${field}.numeric.value`, message: 'Enter the number this condition carries.' });
            if (!prop.numeric.unit) errors.push({ path: `${field}.numeric.unit`, message: 'Name the unit (for example day, week, dollar).' });
            if (!prop.numeric.operator) errors.push({ path: `${field}.numeric.operator`, message: 'Name the operator (for example <=, >=, within).' });
            if (category !== 'condition' && category !== '') errors.push({ path: `${field}.numeric`, message: 'A number or clock belongs on a condition; exceptions and negations do not carry numerics in the gold set.' });
        }
        return prop;
    });
    if (declared === '') errors.push({ path: 'propositionsDeclared', message: 'Say whether this passage carries any conditions, exceptions or negations, or that it carries none.' });
    else if (declared === UNKNOWN) errors.push({ path: 'propositionsDeclared', message: 'Marked UNKNOWN; settle it before committing.', unknown: true });
    else if (declared === 'none' && propositions.length > 0) errors.push({ path: 'propositionsDeclared', message: 'You marked "none" but listed propositions. Remove them or change the declaration.' });
    else if (declared === 'some' && propositions.length === 0) errors.push({ path: 'propositions', message: 'Add at least one proposition, or declare that the passage carries none.' });

    const answer = { modality, actor, propositionsDeclared: declared, propositions, notes: str(input.notes, 'notes') };
    if (actorSpan) answer.actorResolved = { source: actorSpan.kind, index: actorSpan.index, start: actorSpan.start, end: actorSpan.end, slice: actorSpan.slice };
    return { answer, errors, complete: errors.length === 0 };
}

/** Stage B: accept/reject a single proposal, equivalent/different for a pair. */
function validateStageB(item, input) {
    if (!isPlainObject(input)) throw new ShapeError('answer must be an object', 'answer');
    const allowed = VERDICTS[item.form];
    if (!allowed) throw new ShapeError(`fixture ${item.id} has an unknown form`, 'form');
    const verdict = oneOf(input.verdict, allowed, 'verdict');
    const errors = [];
    if (verdict === '') errors.push({ path: 'verdict', message: `Answer ${allowed.join(' or ')}.` });
    else if (verdict === UNKNOWN) errors.push({ path: 'verdict', message: 'Marked UNKNOWN; the scorer counts it as unanswered.', unknown: true });
    const answer = { verdict, note: str(input.note, 'note') };
    return { answer, errors, complete: errors.length === 0 };
}

/** Stage C: same example outcome yes/no, same/different meaning, diverging case when different. */
function validateStageC(item, input) {
    if (!isPlainObject(input)) throw new ShapeError('answer must be an object', 'answer');
    const errors = [];
    const exampleOutcomeSame = oneOf(input.exampleOutcomeSame, ANSWERS.exampleOutcomeSame, 'exampleOutcomeSame');
    const meaning = oneOf(input.meaning, ANSWERS.meaning, 'meaning');
    const divergingCase = str(input.divergingCase, 'divergingCase');
    if (exampleOutcomeSame === '') errors.push({ path: 'exampleOutcomeSame', message: 'Answer yes or no: does the example really come out the same under both versions?' });
    else if (exampleOutcomeSame === UNKNOWN) errors.push({ path: 'exampleOutcomeSame', message: 'Marked UNKNOWN; the scorer counts it as unanswered.', unknown: true });
    if (meaning === '') errors.push({ path: 'meaning', message: 'Answer same or different: do the two versions mean the same thing?' });
    else if (meaning === UNKNOWN) errors.push({ path: 'meaning', message: 'Marked UNKNOWN; the scorer counts it as unanswered.', unknown: true });
    if (meaning === 'different' && !divergingCase.trim()) errors.push({ path: 'divergingCase', message: 'You answered "different": describe a case where the two versions part.' });
    const answer = { exampleOutcomeSame, meaning, divergingCase, note: str(input.note, 'note') };
    return { answer, errors, complete: errors.length === 0 };
}

function validateFor(stage, item, input, options = {}) {
    if (stage === 'A') return validateStageA(item, input, options);
    if (stage === 'B') return validateStageB(item, input);
    if (stage === 'C') return validateStageC(item, input);
    throw new ShapeError(`unknown stage ${stage}`, 'stage');
}

module.exports = {
    UNKNOWN, MODALITIES, CATEGORIES, VERDICTS, ANSWERS, STATES, MAX_TEXT, MAX_PROPOSITIONS,
    ShapeError, validateStageA, validateStageB, validateStageC, validateFor, quoteSource,
};
