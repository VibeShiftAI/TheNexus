const { validateChatRetirement } = require('../services/document-chat-retirement');

const at = n => new Date(Date.UTC(2026, 10, 15, 17, 0, n)).toISOString();
const doc = { id: 'scope', current_revision_id: 'v1', purpose: 'Podcast transcription scope', intended_action: 'none', updated_at: at(0) };
const ref = n => 'nexus://conversation/primary/message/' + n;
const pinned = '/api/documents/scope/raw?revision=v1';
const questions = [
    { id: 'engine', question: 'Which engine?', recommendation: 'Apple', options: [{ id: 'apple', label: 'Apple', action: 'Use Apple.' }] },
    { id: 'downloads', question: 'Approve the downloads?', recommendation: 'Approve', options: [{ id: 'yes', label: 'Yes', action: 'Download.' }] },
];
const revision = { id: 'v1', document_id: 'scope', media_type: 'markdown', captured_at: at(0), content: questions.map(q => q.question).join('\n') };
const row = (n, content, role = 'user') => ({ id: String(n), conversation_id: 'primary', role, content, created_at: at(n) });
function declared() {
    return { doc, revision, definitions: questions, messages: new Map([
        [ref(1), row(1, '/documents/scope decision engine: apple')],
        [ref(2), row(2, '/documents/scope decision downloads: yes')],
    ]), ground: { type: 'chat_ruling', message_ref: ref(2), answers: [
        { decision_id: 'engine', answer: 'apple', message_ref: ref(1) },
        { decision_id: 'downloads', answer: 'yes', message_ref: ref(2) },
    ] } };
}
function prose() {
    const content = '# Podcast transcription: scope\n\n## Decisions\n\n'
        + "**D1. Which transcription engine?** Recommendation: **Apple's built-in on-device transcriber** (SpeechAnalyzer).\n\n"
        + '**D2. Approve the downloads?** Recommendation: **approve.**\n\n'
        + '**D3. Transcribe only new episodes, or also the back catalog?** Recommendation: **new episodes only.**';
    const previous = row(1, 'The [podcast scope](' + pinned + ') is ready. Should I build the scope with all three recommendations (D1, D2 and D3)?', 'assistant');
    return { doc, revision: { ...revision, content }, messages: new Map([[ref(2), { ...row(2, 'Yes, build it'), previous }]]),
        ground: { type: 'chat_ruling', message_ref: ref(2), answers: [] } };
}
test('complete declared answers bind to their own saved operator messages and the closing one', () => {
    const args = declared();
    expect(validateChatRetirement(args)).toEqual({ ok: true, evidence: args.ground });
});
test.each([
    ['partial answers', a => a.ground.answers.pop()],
    ['unrelated closing message', a => { a.ground.message_ref = ref(1); }],
    ['unknown original definitions', a => { a.definitions = null; }],
    ['wrong revision', a => { a.doc = { ...doc, current_revision_id: 'v2' }; }],
    ['missing original chat row', a => a.messages.delete(ref(1))],
    ['wrong chat role', a => { a.messages.get(ref(1)).role = 'assistant'; }],
    ['wrong conversation', a => { a.messages.get(ref(1)).conversation_id = 'secondary'; }],
    ['wrong document', a => { a.messages.get(ref(1)).content = '/documents/another decision engine: apple'; }],
    ['before the revision existed', a => { a.messages.get(ref(1)).created_at = at(-1); }],
    ['unbound choice', a => { a.messages.get(ref(1)).content = 'Apple'; }],
    ['different actual answer', a => { a.messages.get(ref(1)).content = '/documents/scope decision engine: hold'; }],
    ['pending request in same message', a => { a.messages.get(ref(2)).content += '\nAlso send me a revised draft.'; }],
    ['another question in revision', a => { a.revision = { ...revision, content: revision.content + '\nWho will own it?' }; }],
    ['additional request in purpose', a => { a.doc = { ...doc, purpose: 'Choose the engine and separately approve the email.' }; }],
    ['unresolved intended action', a => { a.doc = { ...doc, intended_action: 'send' }; }],
])('keeps the review waiting for %s', (_, change) => {
    const args = declared(); change(args);
    expect(validateChatRetirement(args)).toMatchObject({ ok: false });
});
test('a free-text answer needs Praxis assessment and the actual operator response', () => {
    const args = declared();
    args.definitions = [{ ...questions[0], options: undefined, action: 'Record engine.' }];
    args.revision = { ...revision, content: questions[0].question };
    args.ground.answers = [args.ground.answers[0]];
    args.ground.message_ref = ref(1);
    expect(validateChatRetirement(args).ok).toBe(false);
    args.ground.answers[0].assessed = true;
    expect(validateChatRetirement(args).ok).toBe(true);
    args.messages.get(ref(1)).content = '/documents/scope decision engine: Maybe later.';
    expect(validateChatRetirement(args).ok).toBe(false);
});
test('full-scope operator reply covers each question and recommendation in the revision', () => {
    const result = validateChatRetirement(prose());
    expect(result.ok).toBe(true);
    expect(result.evidence.answers.map(a => [a.decision_id, a.answer, a.message_ref])).toEqual([
        ['D1', "Apple's built-in on-device transcriber", ref(2)], ['D2', 'approve.', ref(2)], ['D3', 'new episodes only.', ref(2)],
    ]);
    expect(result.evidence.context_message_ref).toBe(ref(1));
});
test.each([
    ['unbound yes', a => { delete a.messages.get(ref(2)).previous; }],
    ['partial ruling', a => { a.messages.get(ref(2)).content = 'Yes, D1 only'; }],
    ['conditional ruling', a => { a.messages.get(ref(2)).content = 'Yes, build it after I approve the budget'; }],
    ['unrelated prompt', a => { a.messages.get(ref(2)).previous.content = pinned + ' Should I build a demo?'; }],
    ['scoped-down proposal', a => { a.messages.get(ref(2)).previous.content = pinned + ' D1, D2 and D3 are in the scope. Should I build D1 only?'; }],
    ['different document', a => { a.messages.get(ref(2)).previous.content += ' /documents/another'; }],
    ['other revision', a => { a.messages.get(ref(2)).previous.content = a.messages.get(ref(2)).previous.content.replace('v1', 'v2'); }],
    ['unassessed prose question', a => { a.revision.content += '\nWhat about pricing?'; }],
    ['new numbered choice not in proposal', a => { a.revision.content += '\n**D4. Approve the budget?** Recommendation: **yes**'; }],
    ['unanswered additional request', a => { a.revision.content += '\nPlease choose an owner before proceeding.'; }],
])('keeps an unstructured scope in review for %s', (_, change) => {
    const args = prose(); change(args);
    expect(validateChatRetirement(args).ok).toBe(false);
});

test('answers in a single ordinary operator sentence retain the tool-assessed literal rulings', () => {
    const a = declared();
    a.doc = { ...doc, updated_at: at(0), intended_action: 'implement' };
    const closing = a.messages.get(ref(2));
    closing.previous = row(1, 'I need your choices on the engine and downloads for [the scope](/documents/scope).', 'assistant');
    closing.content = 'Use Apple and approve the downloads.';
    a.ground.answers = [
        { decision_id: 'engine', answer: 'apple', message_ref: ref(2), ruling_quote: 'Use Apple' },
        { decision_id: 'downloads', answer: 'yes', message_ref: ref(2), ruling_quote: 'approve the downloads.' },
    ];
    expect(validateChatRetirement(a).ok).toBe(true);
    closing.content += ' Wait for me to approve the budget.';
    expect(validateChatRetirement(a).ok).toBe(false);
    closing.content = 'Use Apple and approve the downloads.';
    a.ground.answers[0].ruling_quote = 'Choose Google';
    expect(validateChatRetirement(a).ok).toBe(false);
});
test('an ordinary review link binds a whole-scope reply when the document was unchanged since the proposal', () => {
    const a = prose();
    a.doc = { ...doc, updated_at: at(0), intended_action: 'implement' };
    const proposal = a.messages.get(ref(2)).previous;
    proposal.content = 'Here is the [podcast scope](/documents/scope). My recommendations are D1 through D3 as written. Should I build it?';
    expect(validateChatRetirement(a).ok).toBe(true);
    a.doc.updated_at = at(2);
    expect(validateChatRetirement(a).ok).toBe(false);
    a.doc.updated_at = at(0);
    proposal.content = 'Here is the [podcast scope](/documents/scope). I recommend D1. Should I build it?';
    expect(validateChatRetirement(a).ok).toBe(false);
});
test('a separate authorization is still outstanding when it uses the same verb as one answered choice', () => {
    const a = declared();
    a.revision = { ...revision, content: revision.content + '\nPlease approve the separate publicity release.' };
    expect(validateChatRetirement(a).ok).toBe(false);
});

test('numbered plain text questions and recommendation lines form a scope without decision metadata', () => {
    const args = prose();
    args.revision.content = 'Questions\n\n1. Which engine?\nRecommendation: Apple\n\n2. Approve the downloads?\nRecommendation: Approve';
    args.messages.get(ref(2)).previous.content = pinned + ' Should we implement this scope as recommended?';
    expect(validateChatRetirement(args).evidence?.answers.map(a => a.answer)).toEqual(['Apple', 'Approve']);
});
test('the generated handoff ask is covered, a specific subsequent editorial request stays open', () => {
    const args = declared();
    args.doc = { ...doc, title: 'Scope', intended_action: 'implement', metadata: { brief: { ask: 'Review Scope and decide whether it is ready to implement.' } } };
    expect(validateChatRetirement(args).ok).toBe(true);
    args.doc.metadata.brief.ask = 'Answer the two questions in the document.';
    expect(validateChatRetirement(args).ok).toBe(true);
    args.doc.metadata.brief.ask = 'Forward the artwork to Robert.';
    expect(validateChatRetirement(args).ok).toBe(false);
});
test('a build prompt must concern the whole document, not a second proposal in the same message', () => {
    const args = prose();
    args.messages.get(ref(2)).previous.content = pinned + ' I recommend parking the scope and building a different demo. Should I build it?';
    expect(validateChatRetirement(args).ok).toBe(false);
});

test('one unnumbered yes/no question in ordinary prose can be answered directly in the saved exchange', () => {
    const a = prose();
    a.revision.content = 'Pilot scope\n\nShould we start the pilot?\nRecommendation: Start it Monday.';
    const closing = a.messages.get(ref(2));
    closing.content = 'Yes';
    closing.previous.content = 'For the [pilot](' + pinned + '): Should we start the pilot? I recommend starting Monday.';
    const result = validateChatRetirement(a);
    expect(result.ok).toBe(true);
    expect(result.evidence.answers[0]).toMatchObject({ question: 'Should we start the pilot?', answer: 'Yes' });
    closing.previous.content = 'For the [pilot](' + pinned + '): Should we start a trial instead?';
    expect(validateChatRetirement(a).ok).toBe(false);
});

test('a partial saved ruling cannot be attributed to a second choice with a reused or unrelated quote', () => {
    const a = declared();
    const closing = a.messages.get(ref(2));
    closing.previous = row(1, 'Please give the choices for ' + pinned, 'assistant');
    closing.content = 'Choose the Apple engine.';
    a.ground.answers = a.ground.answers.map(entry => ({ ...entry, message_ref: ref(2), ruling_quote: closing.content }));
    expect(validateChatRetirement(a).ok).toBe(false);
    closing.content += ' Apple is the engine.';
    a.ground.answers[1].ruling_quote = 'Apple is the engine.';
    expect(validateChatRetirement(a).ok).toBe(false);
});
test('an unpinned command predating a document update is not a ruling against the restored bytes', () => {
    const a = declared();
    a.doc = { ...doc, updated_at: at(2) };
    expect(validateChatRetirement(a).ok).toBe(false);
});
test('a proposal with an explicit number must account for that many source recommendations', () => {
    const a = prose();
    a.messages.get(ref(2)).previous.content = pinned + ' Should I build the scope with all two recommendations?';
    expect(validateChatRetirement(a).ok).toBe(false);
});

test.each(["Don't choose the Apple engine.", 'Choose the Apple engine and also revise the scope.'])('an assessed quote still has to be an unconditional choice: %s', quote => {
    const a = declared();
    const first = a.messages.get(ref(1));
    first.content = quote;
    first.previous = row(0, 'Which engine? ' + pinned, 'assistant');
    a.ground.answers[0].ruling_quote = quote;
    expect(validateChatRetirement(a).ok).toBe(false);
});

function assessedEngine(quote, answer = 'local', options = [
    { id: 'local', label: 'Apple Local', action: 'Use local.' },
    { id: 'cloud', label: 'Apple Cloud', action: 'Use cloud.' },
], question = questions[0].question) {
    const a = declared();
    a.definitions = [{ ...questions[0], options, question }];
    a.revision = { ...revision, content: question };
    const closing = a.messages.get(ref(2));
    closing.content = quote;
    closing.previous = row(1, 'Which engine? ' + pinned, 'assistant');
    a.ground.answers = [{ decision_id: 'engine', answer, message_ref: ref(2), ruling_quote: quote }];
    return validateChatRetirement(a).ok;
}

test.each([
    ['Reject the Apple Local engine.', 'local'],
    ['Use Apple Cloud.', 'local'],
    ['Use Apple.', 'cloud'],
    ['Choose Apple Local or Apple Cloud.', 'cloud'],
    ['Choose Apple Local and Apple Cloud.', 'local'],
    ['Use Apple Local or something else.', 'local'],
])('option evidence preserves polarity and uniquely identifies the selected option: %s', (quote, answer) => {
    expect(assessedEngine(quote, answer)).toBe(false);
});
test('a longer complete option label distinguishes it from its prefix', () => {
    const options = [{ id: 'apple', label: 'Apple', action: 'Use Apple.' }, { id: 'pro', label: 'Apple Pro', action: 'Use Apple Pro.' }];
    expect(assessedEngine('Use Apple Pro.', 'pro', options)).toBe(true);
    expect(assessedEngine('Use Apple Pro.', 'apple', options)).toBe(false);
    expect(assessedEngine('Use Apple.', 'apple', options)).toBe(true);
});
test.each(['Apple. Should we also buy a license?', 'Apple. Also choose a license.'])('a trailing request on the recommendation line remains outstanding: %s', recommendation => {
    const a = prose();
    a.revision.content = 'Which engine?\nRecommendation: ' + recommendation;
    a.messages.get(ref(2)).previous.content = pinned + ' Should we implement the scope as recommended?';
    expect(validateChatRetirement(a).ok).toBe(false);
});

test('slash-separated alternatives from the original question do not identify one selection', () => {
    const options = [{ id: 'apple', label: 'Apple', action: 'Use Apple.' }, { id: 'google', label: 'Google', action: 'Use Google.' }];
    expect(assessedEngine('Use Apple/Google.', 'apple', options, 'Which engine, Apple or Google?')).toBe(false);
});
