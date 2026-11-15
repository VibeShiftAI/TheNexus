/**
 * Structured document decisions in the viewer (task 50aa5747; the delivery and
 * answer contract is Praxis/docs/document-decisions.md).
 *
 * A producer declares `decision_items` in the registration metadata of a
 * document. Metadata belongs to the document and is merged across
 * registrations, so the registration that declared the items also stamps
 * `decision_items_revision_id` with the revision it recorded. Items count only
 * for that revision: a later revision registered without new items does not
 * inherit them, and items saved before the stamp existed are bound to no
 * revision and cannot be answered here.
 *
 * Robert's answer is a decision for Praxis to carry out within its scope. It
 * is not an editorial decision (approve / request_changes), not a design
 * direction, and never permission to rewrite, publish or send the document.
 *
 * Definitions are immutable for a revision, as Praxis keeps them
 * (registerDocumentDecisions): a registration on the bound revision may repeat
 * the items unchanged but not change or clear them. Each saved answer also
 * records the hash of the definition Robert read, so an answer can only be
 * sent with the question and action it was given against.
 */

const crypto = require('crypto');

const REVISION_KEY = 'decision_items_revision_id';
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** A free-text answer, at most the length of a review comment. */
const MAX_FREE_TEXT = 20000;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value);
}

function prose(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The same rules Praxis applies (src/documents/decisions.ts): stable ids,
 * non-empty question and recommendation, options with an id, label and action,
 * or a free-text action; ids unique. One bad item invalidates the list, as it
 * does in Praxis, so the viewer never offers a decision Praxis would refuse.
 * Registration refuses a list that fails here. An empty list is valid: it
 * declares that the registered revision asks for no decisions.
 */
function parseDecisionItems(value) {
    if (!Array.isArray(value)) return { ok: false, error: 'decision_items must be an array' };
    const items = [];
    const seen = new Set();
    for (const raw of value) {
        if (!isPlainObject(raw)) return { ok: false, error: 'Each decision item must be an object' };
        const extra = Object.keys(raw).filter(key => !['id', 'question', 'recommendation', 'options', 'action'].includes(key));
        if (extra.length) return { ok: false, error: `Unknown decision item field: ${extra[0]}` };
        if (!validId(raw.id)) return { ok: false, error: 'Each decision item needs an id of letters, digits, _ or -' };
        if (seen.has(raw.id)) return { ok: false, error: `Duplicate decision id: ${raw.id}` };
        seen.add(raw.id);
        const question = prose(raw.question);
        const recommendation = prose(raw.recommendation);
        if (!question || !recommendation) return { ok: false, error: `Decision ${raw.id} needs a question and a recommendation` };
        if (raw.action !== undefined && !prose(raw.action)) return { ok: false, error: `Decision ${raw.id} has an empty action` };
        let options;
        if (raw.options !== undefined) {
            if (!Array.isArray(raw.options)) return { ok: false, error: `Decision ${raw.id} options must be an array` };
            options = [];
            const optionIds = new Set();
            for (const option of raw.options) {
                if (!isPlainObject(option) || Object.keys(option).some(key => !['id', 'label', 'action'].includes(key))) {
                    return { ok: false, error: `Decision ${raw.id} has a malformed option` };
                }
                if (!validId(option.id) || optionIds.has(option.id)) return { ok: false, error: `Decision ${raw.id} has a missing or duplicate option id` };
                optionIds.add(option.id);
                const label = prose(option.label);
                const action = prose(option.action);
                if (!label || !action) return { ok: false, error: `Decision ${raw.id} option ${option.id} needs a label and an action` };
                options.push({ id: option.id, label, action });
            }
        }
        if (!options?.length && !prose(raw.action)) return { ok: false, error: `Decision ${raw.id} needs an action or options` };
        items.push({
            id: raw.id, question, recommendation,
            ...(options?.length ? { options } : {}),
            ...(prose(raw.action) ? { action: prose(raw.action) } : {}),
        });
    }
    return { ok: true, items };
}

/**
 * The document's declared decisions and the revision they belong to, or null
 * when none are declared (or the declared list is malformed). `answerable` is
 * true only when the items are bound to `revisionId`.
 */
function decisionItemsFor(doc, revisionId) {
    const metadata = isPlainObject(doc?.metadata) ? doc.metadata : {};
    if (metadata.decision_items === undefined) return null;
    const parsed = parseDecisionItems(metadata.decision_items);
    if (!parsed.ok || parsed.items.length === 0) return null;
    const boundTo = typeof metadata[REVISION_KEY] === 'string' ? metadata[REVISION_KEY] : null;
    return { revision_id: boundTo, answerable: Boolean(boundTo && revisionId && boundTo === revisionId), items: parsed.items };
}

/**
 * Normalize one answer against its decision: an option item takes an option id
 * (or its label, case-insensitive, as Praxis accepts) and records the id; a
 * free-text item takes trimmed text.
 */
function normalizeAnswer(item, raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'invalid_answer', error: 'answer must be a non-empty string' };
    const answer = raw.trim();
    if (item.options?.length) {
        const option = item.options.find(o => o.id === answer) || item.options.find(o => o.label.toLowerCase() === answer.toLowerCase());
        if (!option) {
            return { ok: false, code: 'invalid_answer', error: `answer must be one of the options of decision ${item.id}: ${item.options.map(o => o.id).join(', ')}`, options: item.options.map(o => o.id) };
        }
        return { ok: true, answer: option.id, option };
    }
    if (answer.length > MAX_FREE_TEXT) return { ok: false, code: 'invalid_answer', error: `answer must be at most ${MAX_FREE_TEXT} characters` };
    return { ok: true, answer };
}

/**
 * The fingerprint of one parsed decision (id, question, recommendation,
 * options and action, in the fixed order parseDecisionItems builds). A saved
 * answer carries it as `definition_hash`.
 */
function definitionHash(item) {
    return crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

/** Whether two parsed decision lists hold the same definitions in the same order. */
function sameDefinitions(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Stored draft answers, tolerant of legacy and malformed rows. */
function storedAnswers(review) {
    return Array.isArray(review?.decision_answers) ? review.decision_answers.filter(a => isPlainObject(a) && typeof a.decision_id === 'string' && typeof a.answer === 'string') : [];
}

/**
 * The stored answers that cannot be sent, each with its reason:
 * `decisions_unavailable` (no answerable decisions on the review's revision),
 * `decision_removed`, `definition_changed` (the question, recommendation,
 * options or action differ from what was answered, or the answer predates the
 * recorded definition), or `answer_invalid`.
 */
function unsendableAnswers(stored, decisions) {
    const byId = new Map(decisions?.answerable ? decisions.items.map(item => [item.id, item]) : []);
    const unsendable = [];
    for (const entry of stored) {
        const item = byId.get(entry.decision_id);
        let reason = null;
        if (!decisions?.answerable) reason = 'decisions_unavailable';
        else if (!item) reason = 'decision_removed';
        else if (entry.definition_hash !== definitionHash(item)) reason = 'definition_changed';
        else {
            const normalized = normalizeAnswer(item, entry.answer);
            if (!normalized.ok || normalized.answer !== entry.answer) reason = 'answer_invalid';
        }
        if (reason) unsendable.push({ decision_id: entry.decision_id, answer: entry.answer, reason });
    }
    return unsendable;
}

/**
 * Check every stored answer against the decisions bound to the review's
 * revision and return them in declaration order. Fails when any answer cannot
 * be sent (see unsendableAnswers), naming the first and listing all.
 */
function resolveAnswers(stored, decisions) {
    if (!stored.length) return { ok: true, answers: [] };
    const unsendable = unsendableAnswers(stored, decisions);
    if (unsendable.length) return { ok: false, decision_id: unsendable[0].decision_id, unsendable };
    const order = new Map(decisions.items.map((item, index) => [item.id, index]));
    return { ok: true, answers: [...stored].sort((a, b) => order.get(a.decision_id) - order.get(b.decision_id)) };
}

/**
 * The latest answer to each decision that a finished review on `revisionId`
 * sent to Praxis, oldest round first so a later round's answer wins. The
 * viewer shows these beside a new round, so an answer is never given twice
 * without seeing the first.
 */
function latestSentAnswers(reviews, revisionId) {
    const sent = new Map();
    const rounds = (reviews || [])
        .filter(review => review.status === 'submitted' && review.revision_id === revisionId)
        .sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
    for (const review of rounds) {
        for (const entry of storedAnswers(review)) {
            sent.set(entry.decision_id, { decision_id: entry.decision_id, answer: entry.answer, review_id: review.id, submitted_at: review.submitted_at || null });
        }
    }
    return [...sent.values()];
}

/** Incoming registration metadata without the stamp, which only Nexus writes. */
function withoutRevisionStamp(metadata) {
    if (!isPlainObject(metadata) || !(REVISION_KEY in metadata)) return metadata;
    const { [REVISION_KEY]: _ignored, ...rest } = metadata;
    return rest;
}

/** Whether a registration declared decision items (and so moves the stamp). */
function declaresDecisionItems(metadata) {
    return isPlainObject(metadata) && metadata.decision_items !== undefined;
}

module.exports = {
    REVISION_KEY,
    MAX_FREE_TEXT,
    parseDecisionItems,
    decisionItemsFor,
    normalizeAnswer,
    definitionHash,
    sameDefinitions,
    storedAnswers,
    unsendableAnswers,
    resolveAnswers,
    latestSentAnswers,
    withoutRevisionStamp,
    declaresDecisionItems,
};
