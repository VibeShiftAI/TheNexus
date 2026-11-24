/** Evidence for moving a review to Reference. Only the caller looks up chat
 * rows, checks the credential and writes the retirement. This module never
 * records decisions or runs a document's intended action. */
const { normalizeAnswer, parseDecisionItems } = require('./document-decision-items');

const { specificBriefAsk } = require('./document-retirement-purpose');

const refuse = error => ({ ok: false, code: 'inconclusive_chat_ruling', error });
const messageRef = row => `nexus://conversation/${encodeURIComponent(row.conversation_id)}/message/${encodeURIComponent(row.id)}`;
const fold = text => text.trim().toLowerCase().replace(/\s+/g, ' ');
const writtenNumbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const docLinks = text => [...text.matchAll(/\/(?:api\/)?documents\/([\w-]+)(?:\/raw\?revision=([\w-]+))?/g)];
const replyToWholeScope = /^(?:yes(?:,? (?:build it|go ahead|proceed))?|build it|go ahead|proceed|approved)[.!]?$/i;

/** A plain review URL is authoritative only while this record has remained
 * unchanged since the cited turn. An exact revision URL supplies its own pin. */
function bindsDocument(row, doc, revision) {
    const links = docLinks(row.content);
    if (!links.length || links.some(link => link[1] !== doc.id || (link[2] && link[2] !== revision.id))) return false;
    return links.some(link => link[2] === revision.id) || Date.parse(row.created_at) >= Date.parse(doc.updated_at);
}

function before(left, right) {
    const a = Date.parse(left.created_at), b = Date.parse(right.created_at);
    return a < b || (a === b && Number.isInteger(left.rowid) && Number.isInteger(right.rowid) && left.rowid < right.rowid);
}

function proposalContext(row, doc, revision) {
    const previous = row.previous;
    if (!previous || previous.role !== 'assistant' || !previous.id || typeof previous.content !== 'string'
        || previous.conversation_id !== row.conversation_id || !before(previous, row)
        || !(Date.parse(previous.created_at) >= Date.parse(revision.captured_at))) return null;
    return bindsDocument(previous, doc, revision) ? previous : null;
}

/** A single build question can accept the recommendations in the attached
 * scope. If the proposal narrows them to a list, it must name every item. */
function wholeScopeProposal(text, items) {
    const clean = text.replace(/\/raw\?revision=[\w-]+/g, '');
    if (clean.split('?').length !== 2 || /\b(?:except|excluding|without|defer|partial|only (?:build|implement|D\d+))\b/i.test(clean)) return false;
    const ask = clean.match(/\b(?:should (?:i|we)|shall (?:i|we)|do you want (?:me|us) to|would you like (?:me|us) to)\s+(?:build|implement|proceed with)\s+([^?]+)\?/i)?.[1];
    if (!ask) return false;
    const count = /\ball (\w+) recommendations\b/i.exec(ask)?.[1]?.toLowerCase();
    if (count && count !== 'the' && (writtenNumbers[count] || Number(count)) !== items.length) return false;
    const aside = ask.match(/\(([^()]*)\)/)?.[1];
    if (aside && !/^(?:D\d+|and|to|through|[,\s–—-])+$/i.test(aside)) return false;
    const selection = ask.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!/^(?:(?:this|that|the|full|entire|whole|proposed) )*(?:scope|proposal|plan|it)(?:\s+(?:as (?:recommended|proposed|written)|with (?:all (?:[\w-]+ )?)?(?:the )?recommendations?))?$/i.test(selection)) return false;
    const listed = new Set([...clean.matchAll(/\bD\d+\b/gi)].map(match => match[0].toUpperCase()));
    for (const range of clean.matchAll(/\bD(\d+)\s*(?:to|through|[-–—])\s*D(\d+)\b/gi)) {
        const low = Number(range[1]), high = Number(range[2]);
        if (low > high || high - low >= items.length) return false;
        for (let n = low; n <= high; n++) listed.add('D' + n);
    }
    if (listed.size && (listed.size !== items.length || items.some(item => !listed.has(item.id)))) return false;
    if (selection === 'it' && !listed.size && !/\b(?:all|the full set of) (?:the )?recommendations\b/i.test(clean)) return false;
    return /\brecommend(?:ed|ations?)?\b/i.test(clean) || /\b(?:full|whole|entire) scope\b/i.test(selection);
}

/** Older scopes put their inventory in a Markdown Decisions section. Read
 * only a complete labelled question + recommendation, never a quote from
 * the body telling us Robert agreed. Unrecognised requests keep the review. */
function proseItems(content) {
    const section = content.match(/^(?:#{1,6}[ \t]+)?(?:Decisions(?: needed)?|(?:Open )?Questions)[ \t]*:?[ \t]*$([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im)?.[1];
    const items = [];
    const pattern = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?(?:D?([1-9]\d*)[.:)][ \t]+)?([^?\n]+\?)(?:\*\*)?\s+Recommendation:\s*(?:\*\*([^*\n]+)\*\*|([^\n]+))/gim;
    for (const match of (section || content).matchAll(pattern)) {
        const number = items.length + 1;
        if (match[1] && Number(match[1]) !== number) return [];
        items.push({ id: 'D' + number, question: match[2].trim(), recommendation: (match[3] || match[4]).trim() });
    }
    return items;
}

/** Declared decisions can coexist with editorial questions and requests.
 * Check the revision and its review purpose after accounting for the supplied
 * questions. A nonempty brief ask is also part of what Robert was asked. */
function hasOtherAsk(doc, revision, items) {
    const brief = specificBriefAsk(doc);
    const restatement = /^(?:answer|settle|decide) (?:all )?(?:the |these )?(?:(\d+|two|three|four|five) )?(?:declared |outstanding )?(?:choices|questions|decisions)(?: in (?:the|this) (?:document|scope))?[.!]?$/i.exec(brief);
    if (brief && !items.some(item => fold(brief) === fold(item.question))) {
        if (!restatement) return true;
        const count = restatement[1]?.toLowerCase();
        if (count && (writtenNumbers[count] || Number(count)) !== items.length) return true;
    }
    let rest = [doc.title || '', revision.content, doc.purpose || ''].join('\n').toLowerCase();
    for (const item of items) rest = rest.replaceAll(item.question.toLowerCase(), '');
    // A recommendation can start with a verb such as “approve”. Preserve its
    // words: a later clause on that very line can contain another request.
    rest = rest.replace(/[*_]/g, '').replace(/\brecommendation:\s*/g, 'the recommendation is ');
    return rest.includes('?') || /\b(?:please|kindly|we need you to|you (?:must|need to)|awaiting (?:your|robert.s)|pending (?:your|robert.s)|needs? (?:your|robert.s))\b/i.test(rest)
        || /(?:^\s*(?:[-*#]+\s*)?|[.!;:]\s+|\b(?:and|but|also|still|separately)\s+)(?:choose|decide|confirm|approve|authorize|sign off|reply|select|provide|specify|name an? |revise|rewrite|send me|tell (?:us|me)|let (?:us|me) know)\b/im.test(rest)
        || /\b(?:outstanding|pending|unanswered|unresolved)\s+(?:question|request|approval|choice|decision|feedback)\b/i.test(rest);
}

function readCommands(text, row, doc, revision) {
    const commands = [];
    let bound = false;
    for (const line of text.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        if (line.startsWith('PRAXIS_DOCUMENT_DECISION:')) {
            let marker;
            try { marker = JSON.parse(line.slice('PRAXIS_DOCUMENT_DECISION:'.length)); } catch { return null; }
            if (marker?.document_id !== revision.document_id || marker.revision_id !== revision.id) return null;
            commands.push(marker);
            bound = true;
        } else {
            const match = /^(?:\/documents\/([\w-]+)\s+)?decision\s+([\w-]+):\s*(.+)$/i.exec(line);
            if (!match || (match[1] && match[1] !== revision.document_id)) return null;
            commands.push({ decision_id: match[2], answer: match[3] });
            if (match[1]) {
                if (!bindsDocument(row, doc, revision)) return null;
                bound = true;
            }
        }
    }
    return (bound || proposalContext(row, doc, revision)) && commands.length ? commands : null;
}

function matchesSavedAnswer(item, entry, raw) {
    const parsed = normalizeAnswer(item, raw);
    if (!parsed.ok || parsed.answer !== entry.answer) return false;
    if (item.options?.length) return true;
    return entry.assessed === true && !/[?]/.test(raw)
        && !/\b(?:later|maybe|not sure|undecided|hold off|i(?:'ll| will) decide|to be (?:determined|decided))\b/i.test(raw);
}

// A quote used to interpret natural language must identify the particular
// choice. Shared option words such as “adopt” cannot identify two checkpoints.
const words = text => fold(text).match(/[\p{L}\p{N}_-]+/gu) || [];
const questionWords = item => new Set(words([item.id, item.question, ...(item.options || []).map(o => o.id + ' ' + o.label)].join(' ')));
const genericWords = new Set(words('a an the and or to is of on we it as do how which what should would can for this that use'));
function identifiesChoice(quote, item, items) {
    const otherWords = new Set();
    for (const other of items.values()) if (other.id !== item.id) {
        for (const word of questionWords(other)) otherWords.add(word);
    }
    const tokens = questionWords(item);
    return words(quote).some(word => tokens.has(word) && !otherWords.has(word) && !genericWords.has(word));
}

const affirmative = ['yes', 'approve', 'adopt', 'accept'];
const negative = ['no', 'reject', 'decline'];

/** Read a quoted choice as a complete option name (optionally introduced
 * by “choose”, “use”, etc.). Only the named question may qualify the
 * selection. Matching the longest complete name preserves Apple vs Apple Pro. */
function supportsSelection(quote, item, answer) {
    if (!item.options?.length) return fold(quote).includes(fold(answer));
    const selection = words(quote).join(' ').replace(/^(?:i (?:choose|prefer|want)|go with|choose|select|pick|keep|use|take|start) (?:the )?/, '');
    const matches = [], alternatives = [];
    for (const option of item.options) {
        const names = [option.id, option.label].map(name => words(name).join(' ')).filter(Boolean);
        for (const group of [affirmative, negative]) if (names.some(name => group.includes(name))) names.push(...group);
        if (option.id !== answer) alternatives.push(...names);
        for (const name of names) {
            if (selection === name || selection.startsWith(name + ' ')) matches.push({ id: option.id, name });
        }
    }
    if (!matches.length) return false;
    const longest = Math.max(...matches.map(match => match.name.length));
    const strongest = matches.filter(match => match.name.length === longest);
    if (!strongest.every(match => match.id === answer)) return false;
    const qualifier = selection.slice(longest).trim();
    if (!qualifier) return true;
    if (alternatives.some(name => (' ' + qualifier + ' ').includes(' ' + name + ' '))) return false;
    if (/\b(?:and|or|not|never|no|instead|reject|decline|except)\b/.test(qualifier)) return false;
    const subject = new Set(words(item.id + ' ' + item.question + ' for the'));
    return words(qualifier).every(word => subject.has(word));
}

function confirmsMessage(entries, items, row, doc, revision) {
    const commands = readCommands(row.content, row, doc, revision);
    if (commands) {
        // Repeating a changed answer or appending a second request is not a
        // single unambiguous ruling. Validate the entire saved turn.
        return commands.length === entries.length && entries.every(entry => {
            const matching = commands.filter(command => command.decision_id === entry.decision_id);
            return matching.length === 1 && matchesSavedAnswer(items.get(entry.decision_id), entry, matching[0].answer);
        });
    }
    const context = proposalContext(row, doc, revision);
    if (entries.every(entry => typeof entry.ruling_quote === 'string' && entry.ruling_quote.trim())) {
        // The authenticated Praxis answer tool interprets natural language.
        // Its quoted rulings must account for the entire saved turn. A stray
        // second request, condition or another document leaves review open.
        const links = docLinks(row.content);
        if (links.length ? !bindsDocument(row, doc, revision) : !context) return false;
        let remaining = row.content;
        for (const entry of entries) {
            const quote = entry.ruling_quote;
            const item = items.get(entry.decision_id);
            if (!remaining.includes(quote) || !row.content.includes(quote) || !matchesSavedAnswer(item, entry, entry.answer)
                || !supportsSelection(quote, item, entry.answer)
                || (!identifiesChoice(quote, item, items) && !(entries.length === 1 && context && fold(context.content).includes(fold(item.question))))
                || /\?|\b(?:if|unless|except|maybe|later|not sure|undecided|still need|also|separately|and then|but|wait (?:for|until)|and (?:revise|rewrite|send|publish|review|decide|confirm))\b/i.test(quote)) return false;
            remaining = remaining.replace(quote, '');
        }
        remaining = remaining.replace(/\/(?:api\/)?documents\/[\w-]+(?:\/raw\?revision=[\w-]+)?/g, '');
        return /^[\s,.:;!–—-]*$/.test(remaining.replace(/\band\b/gi, ''));
    }
    // Natural replies require a single decision identified by the immediately
    // preceding version-bound question. Never interpret an unrelated saved 'yes'.
    if (entries.length !== 1) return false;
    const entry = entries[0], item = items.get(entry.decision_id);
    if (!context || !fold(context.content).includes(fold(item.question)) || docLinks(row.content).length) return false;
    if ((context.content.replace(/\/raw\?revision=[\w-]+/g, '').match(/\?/g) || []).length !== 1) return false;
    return matchesSavedAnswer(item, entry, row.content);
}

function validateChatRetirement({ doc, revision, definitions, ground, messages }) {
    if (!revision || !doc || doc.current_revision_id !== revision.id || doc.id !== revision.document_id
        || !['markdown', 'text'].includes(revision.media_type || 'markdown') || typeof revision.content !== 'string' || !revision.content.trim()
        || (doc.intended_action && !['none', 'implement'].includes(doc.intended_action))) return refuse('The complete current review request could not be verified.');
    if (ground?.type !== 'chat_ruling' || !Array.isArray(ground.answers) || !(messages instanceof Map))
        return refuse('A saved operator ruling and its answer citations are required.');
    const saved = ref => {
        const row = messages.get(ref);
        return row?.role === 'user' && row.id && row.conversation_id && messageRef(row) === ref && typeof row.content === 'string'
            && Date.parse(row.created_at) >= Date.parse(revision.captured_at) ? row : null;
    };
    const closing = saved(ground.message_ref);
    if (!closing) return refuse('The cited closing message is not a saved operator turn for this revision.');
    const declared = definitions === undefined ? { ok: true, items: [] } : parseDecisionItems(definitions);
    if (!declared.ok || (definitions === undefined && doc.metadata?.decision_items !== undefined
        && !doc.metadata?.decision_items_revision_id)) return refuse('The original decision definitions are unavailable.');
    if (!declared.items.length) {
        const items = proseItems(revision.content);
        const previous = proposalContext(closing, doc, revision);
        if (!items.length || ground.answers.length || hasOtherAsk(doc, revision, items) || !previous)
            return refuse('The saved exchange does not settle every question in the current scope.');
        const proposal = previous.content.replace(/\/raw\?revision=[\w-]+/g, '');
        const directAnswer = items.length === 1 && /^(?:yes|no)[.!]?$/i.test(closing.content.trim())
            && /^(?:should|shall|can|will|do|does|is|are|would)\b/i.test(items[0].question) && !/\bor\b/i.test(items[0].question)
            && (proposal.match(/\?/g) || []).length === 1 && fold(proposal).includes(fold(items[0].question));
        if (!directAnswer && !(replyToWholeScope.test(closing.content.trim()) && wholeScopeProposal(proposal, items)))
            return refuse('The saved reply does not answer the question or accept the whole scope.');
        return { ok: true, evidence: { type: 'chat_ruling', message_ref: ground.message_ref, context_message_ref: messageRef(previous),
            answers: items.map(item => ({ decision_id: item.id, question: item.question,
                answer: directAnswer ? closing.content.trim() : item.recommendation, message_ref: ground.message_ref })) } };
    }
    const byId = new Map(declared.items.map(item => [item.id, item]));
    const covered = new Set(), byMessage = new Map();
    if (hasOtherAsk(doc, revision, declared.items)) return refuse('The review asks for more than the cited decisions.');
    for (const entry of ground.answers) {
        const row = saved(entry?.message_ref);
        if (!row || !byId.has(entry.decision_id) || covered.has(entry.decision_id)
            || (entry.message_ref !== ground.message_ref && !before(row, closing)))
            return refuse('Each answer must identify one declared question and its saved operator message, up to the closing ruling.');
        covered.add(entry.decision_id);
        if (!byMessage.has(entry.message_ref)) byMessage.set(entry.message_ref, []);
        byMessage.get(entry.message_ref).push(entry);
    }
    if (covered.size !== byId.size || !byMessage.has(ground.message_ref)) return refuse('The cited closing turn does not complete the decision set.');
    for (const [ref, entries] of byMessage) {
        if (!confirmsMessage(entries, byId, saved(ref), doc, revision)) return refuse('The saved chat text does not establish the answer to its cited question.');
    }
    return { ok: true, evidence: { type: 'chat_ruling', message_ref: ground.message_ref,
        answers: ground.answers.map(({ decision_id, answer, message_ref, ruling_quote }) => ({ decision_id, answer, message_ref, ...(ruling_quote ? { ruling_quote } : {}) })) } };
}

module.exports = { validateChatRetirement };
