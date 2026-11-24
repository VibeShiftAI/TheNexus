// A withdrawal must describe the present review. Incidental mentions of "no
// approval", partial withdrawals and conditional plans leave the review open.
const decision = '(?:decision|approval|review|action|input|response|feedback|sign[- ]off|send(?:ing)?|deploy(?:ment)?|publication)';
const list = decision + '(?:(?:,? (?:or|and) |, )' + decision + ')*';
const recipient = '(?: from (?:you|robert))?';
const withdrawal = [
    new RegExp('^no (?:current |further )?(' + list + ')' + recipient + ' (?:is |are )?(?:currently |being )?(?:requested|required|needed)' + recipient + '$', 'i'),
    new RegExp('^(?:this (?:document|preview|report) )?(?:does not (?:request|require)(?: any)?|(?:requests|requires|needs) no) (' + list + ')' + recipient + '$', 'i'),
];
// Descriptive noun phrases may accompany a withdrawal. An independent
// instruction in the same sentence still needs to reach Robert.
const archivalDescription = /^(?:(?:this (?:document|preview|report) is )?(?:historical|archived|superseded|reference[- ]only|not (?:a |an |the )?(?:current|active))(?: (?:status|email|send-ready|report|document|preview|copy|draft|record|version|for reference))*|(?:(?:this (?:document|preview|report) is )?for )?reference only)$/i;

function mentionsWithdrawal(purpose) {
    return /\bno (?:current |further )?(?:decision|approval|review|action|input|response|feedback|sign[- ]off|send|deployment|publication)\b|\bdoes not (?:request|require)\b/i.test(purpose || '');
}

function purposeWithdrawsReview(purpose) {
    const clauses = String(purpose || '').trim().split(/[.;\n]+/).map(s => s.trim()).filter(Boolean);
    let withdrawn = false;
    for (const clause of clauses) {
        const match = withdrawal.map(pattern => pattern.exec(clause)).find(Boolean);
        if (match) {
            if (/\b(decision|approval|review|action|input|response|feedback|sign[- ]off)\b/i.test(match[1])) withdrawn = true;
        } else if (!archivalDescription.test(clause)) {
            return false;
        }
    }
    return withdrawn;
}

// Praxis uses this sentence as the generic call to open the review. A more
// specific ask supplied by the producer remains part of the review request.
function specificBriefAsk(doc) {
    const ask = doc.metadata?.brief?.ask;
    if (typeof ask !== 'string') return '';
    const action = doc.intended_action;
    const generic = `Review ${doc.title} and decide whether it is ready${action && action !== 'none' ? ' to ' + action : ''}.`;
    return ask.trim() === generic || purposeWithdrawsReview(ask) ? '' : ask.trim();
}

// Inspect static HTML copy without executing it or following links. Leave
// reviews with embedded, interactive or unassessed content in the queue.
function reviewText(revision) {
    if (typeof revision?.content !== 'string') return null;
    if (['markdown', 'text'].includes(revision.media_type || 'markdown')) return revision.content;
    if (revision.media_type !== 'html') return null;
    const html = revision.content;
    if (/\bcontent\s*:|@import|\burl\s*\(/i.test(html)) return null;
    const blocks = /^(?:html|head|body|title|main|article|section|header|footer|h[1-6]|p|div|br|hr|ul|ol|li|table|thead|tbody|tr|th|td|blockquote)$/i;
    const inline = /^(?:a|b|strong|i|em|span|u|small|font)$/i;
    const attributes = /\s+(?:class|id|lang|dir|role|align|valign|width|height|cellpadding|cellspacing|border|bgcolor|style|href|target|rel|charset|name|content)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/gi;
    const copy = html.replace(/<!doctype html\s*>/gi, '').replace(/<style(?:\s+type=["']text\/css["'])?\s*>[^<>]*<\/style\s*>/gi, '')
        .replace(/<(\/?)([a-z][\w-]*)([^<>]*)>/gi, (tag, closing, name, rest) => {
            if ((!blocks.test(name) && !inline.test(name) && name.toLowerCase() !== 'meta')
                || !(closing ? /^\s*$/.test(rest) : /^\s*\/?$/.test(rest.replace(attributes, '')))) return tag;
            return blocks.test(name) ? '\n' : '';
        });
    if (/[<>]/.test(copy)) return null;
    // Common typographic entities do not carry a request. Unknown named
    // entities can change the meaning of the visible words.
    const named = { amp: '&', nbsp: ' ', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };
    let readable = true;
    const text = copy.replace(/&(#\d+|#x[\da-f]+|[a-z][\w]*);?/gi, (entity, code) => {
        if (code.startsWith('#')) {
            const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
            if (n > 0 && n <= 0x10ffff) return String.fromCodePoint(n);
        } else if (Object.hasOwn(named, code)) return named[code];
        readable = false;
        return entity;
    });
    return readable ? text : null;
}

function hasOutstandingRequest(doc, revision) {
    const content = reviewText(revision);
    if (content === null) return true;
    const items = doc.metadata?.decision_items;
    if (items !== undefined && (!Array.isArray(items) || (items.length && (!doc.metadata.decision_items_revision_id || doc.metadata.decision_items_revision_id === revision.id)))) return true;
    // Strip Markdown list/heading/emphasis markers so “- **Choose an owner**”
    // has the same meaning as a plain instruction.
    if (specificBriefAsk(doc)) return true;
    const purpose = purposeWithdrawsReview(doc.purpose) ? '' : doc.purpose;
    const prose = [doc.title, purpose, content].filter(Boolean).join('\n')
        .replace(/^[ \t]*(?:[-*#>]+|\d+[.)])[ \t]+/gm, '').replace(/[*_]/g, '');
    const pending = /\b(?:please|kindly|whether|we need you to|you (?:must|need to)|(?:your|robert.s) (?:input|approval|review|choice|confirmation|decision|feedback)|for robert to (?:decide|choose|confirm|review)|(?:outstanding|unresolved|open|pending) (?:question|approval|decision)|(?:decision|approval|input) (?:is )?(?:still )?(?:required|needed|requested))\b/i;
    const instruction = /(?:^|[.!;:,\n]\s*|\b(?:and|but|also|still)\s+)(?:choose|decide|select|confirm|approve|review|authorize|tell (?:us|me)|let (?:us|me) know|pick|sign off|which|should (?:we|i)|provide|name|specify|reply|respond|vote|send|publish|deploy)\b/im;
    return prose.includes('?') || pending.test(prose) || instruction.test(prose);
}

module.exports = { mentionsWithdrawal, purposeWithdrawsReview, hasOutstandingRequest, specificBriefAsk };
