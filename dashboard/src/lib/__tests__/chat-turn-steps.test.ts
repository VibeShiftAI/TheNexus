import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTurnStepsStore, followSpacingMs, foldedLabel, formatElapsed, hiddenStepCount, isTurnStep, mergeTurnSteps,
    upsertTurnStep, type TurnStep,
} from '../chat-turn-steps';

const step = (seq: number, patch: Partial<TurnStep> = {}): TurnStep => ({ id: `s${seq}`, seq, kind: 'tool', text: `Step ${seq}`, status: 'running', ...patch });

test('steps stay in Praxis order, update in place and a closed step never reopens', () => {
    let steps = upsertTurnStep([], step(2));
    steps = upsertTurnStep(steps, step(1));
    steps = upsertTurnStep(steps, step(3));
    assert.deepEqual(steps.map(s => s.seq), [1, 2, 3]);
    steps = upsertTurnStep(steps, step(2, { status: 'done', text: 'Read a file' }));
    assert.deepEqual(steps.map(s => [s.seq, s.status]), [[1, 'running'], [2, 'done'], [3, 'running']]);
    assert.equal(steps[1].text, 'Read a file');
    steps = upsertTurnStep(steps, step(2, { status: 'running', text: 'Read a file' }));
    assert.equal(steps[1].status, 'done');
});

test('a step keeps only its display fields', () => {
    const [kept] = upsertTurnStep([], { ...step(1), raw_command: 'not for display' } as TurnStep);
    assert.deepEqual(Object.keys(kept).sort(), ['id', 'kind', 'seq', 'status', 'text']);
});

test('a malformed frame is not a step', () => {
    assert.equal(isTurnStep(step(1)), true);
    for (const bad of [null, 'x', { ...step(1), seq: '1' }, { ...step(1), text: 3 }, { ...step(1), kind: 'other' }, { ...step(1), status: 'other' }]) {
        assert.equal(isTurnStep(bad), false);
    }
});

test('elapsed time reads plainly at every scale', () => {
    assert.deepEqual([400, 8_200, 59_999, 72_000, 3_599_000, 3_780_000].map(formatElapsed),
        ['under 1s', '8s', '59s', '1m 12s', '59m 59s', '1h 03m']);
});

test('the folded line states the measured duration, the count and anything that went wrong', () => {
    assert.equal(foldedLabel({ durationMs: 72_000, stepCount: 8, steps: [] }), 'Worked for 1m 12s · 8 steps');
    assert.equal(foldedLabel({ durationMs: 3_000, stepCount: 1, steps: [] }), 'Worked for 3s · 1 step');
    assert.equal(foldedLabel({ durationMs: 9_000, stepCount: 3, steps: [step(1, { status: 'failed' }), step(2, { status: 'unfinished' }), step(3, { status: 'done' })] }),
        'Worked for 9s · 3 steps · 1 failed · 1 did not finish');
});

test('the start time comes from Praxis and survives network delay', () => {
    let clock = 10_000;
    const store = createTurnStepsStore(() => clock);
    store.begin('t', 'c', 'Sending');
    assert.equal(store.live('c')!.startedAt, 10_000);
    clock = 12_000;
    store.noteStatus('t', { state: 'accepted', message: 'Received', elapsed_ms: 1_500 });
    assert.equal(store.live('c')!.startedAt, 10_500);
    clock = 15_000;
    store.noteStep('t', { ...step(1), elapsed_ms: 4_000 });
    assert.equal(store.live('c')!.startedAt, 10_500, 'a late frame does not move the start later');
    clock = 16_000;
    store.noteStep('t', { ...step(2), elapsed_ms: 5_800 });
    assert.equal(store.live('c')!.startedAt, 10_200, 'a less delayed frame moves it earlier');
});

test('a degraded state stays visible for the rest of the turn and ordinary status keeps updating', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Sending');
    store.noteStatus('t', { state: 'preparing', message: 'Preparing' });
    store.noteStatus('t', { state: 'degraded', message: 'The fallback agent is taking this message.' });
    assert.equal(store.live('c')!.status, 'Preparing');
    assert.equal(store.live('c')!.warning, 'The fallback agent is taking this message.');
    store.noteStatus('t', { state: 'verifying', message: 'Checking the reply' });
    assert.equal(store.live('c')!.status, 'Checking the reply');
    assert.equal(store.live('c')!.warning, 'The fallback agent is taking this message.');
});

test('the running status sentence is not kept, and the statuses around it still show', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Sending');
    store.noteStatus('t', { state: 'preparing', message: 'Preparing' });
    store.noteStatus('t', { state: 'running', message: 'The chat session is working. Its final result is not yet confirmed.' });
    assert.equal(store.live('c')!.status, '');
    assert.equal(store.live('c')!.warning, null);
    store.noteStatus('t', { state: 'verifying', message: 'Checking the reply' });
    assert.equal(store.live('c')!.status, 'Checking the reply');
});

test('folding closes running steps truthfully and uses the duration Praxis measured', () => {
    const store = createTurnStepsStore(() => 50_000);
    store.begin('t', 'c', 'Working');
    store.noteStep('t', step(1, { status: 'done' }));
    store.noteStep('t', step(2));
    store.fold('t', 'reply', { duration_ms: 42_000, step_count: 2 });
    assert.equal(store.live('c'), null);
    const folded = store.getFolded().get('reply')!;
    assert.equal(folded.durationMs, 42_000);
    assert.deepEqual(folded.steps.map(s => s.status), ['done', 'unfinished']);
});

test('a turn with no steps leaves no folded line', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Working');
    store.fold('t', 'reply', { duration_ms: 1_000 });
    assert.equal(store.getFolded().size, 0);
    assert.equal(store.live('c'), null);
});

test('a very long turn keeps every step with all of its text, from the first on', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Working');
    const longText = `${'Review the complete change '.repeat(400)}END_OF_TEXT`;
    store.noteStep('t', step(1, { status: 'done', text: longText }));
    for (let seq = 2; seq <= 2_003; seq += 1) store.noteStep('t', step(seq, { status: 'done' }));
    const turn = store.live('c')!;
    assert.equal(turn.steps.length, 2_003);
    assert.equal(turn.steps[0].seq, 1);
    assert.equal(turn.steps[0].text, longText);
    assert.equal(turn.steps[2_002].seq, 2_003);
    assert.equal(hiddenStepCount(turn), 0);
    store.fold('t', 'reply', { duration_ms: 1_000, step_count: 2_003 });
    const line = store.getFolded().get('reply')!;
    assert.equal(line.steps.length, 2_003);
    assert.equal(line.steps[0].text, longText);
    assert.equal(hiddenStepCount(line), 0);
});

test('a count above what reached the page is reported, never made up', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Working');
    store.noteStep('t', step(4, { status: 'done' }));
    assert.equal(hiddenStepCount(store.live('c')!), 3);
    store.applyReceipt('t', { state: 'in_progress', steps: [step(1), step(2), step(3)], step_count: 4 });
    assert.equal(hiddenStepCount(store.live('c')!), 0);
    assert.deepEqual(store.live('c')!.steps.map(s => s.seq), [1, 2, 3, 4]);
});

test('a batch merge keeps order, closes nothing back open and returns the same list when nothing changed', () => {
    const held = [step(1, { status: 'done' }), step(3)];
    const merged = mergeTurnSteps(held, [step(1, { status: 'running' }), step(2, { status: 'failed' }), step(3, { status: 'done', text: 'Read a file' }), { bad: true }]);
    assert.deepEqual(merged.map(s => [s.seq, s.status]), [[1, 'done'], [2, 'failed'], [3, 'done']]);
    assert.equal(merged[2].text, 'Read a file');
    assert.equal(mergeTurnSteps(merged, merged), merged);
    assert.equal(mergeTurnSteps(merged, undefined), merged);
});

test('replaying a long turn is one pass over its steps', () => {
    const incoming = Array.from({ length: 200_000 }, (_, at) => step(at + 1, { status: 'done' }));
    const started = performance.now();
    const merged = mergeTurnSteps([], incoming);
    const again = mergeTurnSteps(merged, incoming);
    assert.equal(merged.length, 200_000);
    assert.equal(again, merged);
    // Inserting one by one takes minutes at this size, so a quadratic merge cannot pass.
    assert.ok(performance.now() - started < 10_000);
});

test('the status route fills in steps a dropped stream missed', () => {
    const store = createTurnStepsStore(() => 9_000);
    store.begin('t', 'c', 'Working', true);
    store.noteStep('t', step(1));
    store.applyReceipt('t', { state: 'in_progress', steps: [step(1, { status: 'done' }), step(2), { bad: true }], step_count: 2, elapsed_ms: 6_000 });
    const turn = store.live('c')!;
    assert.deepEqual(turn.steps.map(s => [s.seq, s.status]), [[1, 'done'], [2, 'running']]);
    assert.equal(turn.startedAt, 3_000);
});

test('release ends a send with no reply unless the turn is still being followed', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('plain', 'c', 'Working');
    store.release('plain');
    assert.equal(store.has('plain'), false);
    store.begin('followed', 'c', 'Working');
    store.startFollowing('followed');
    store.release('followed');
    assert.equal(store.has('followed'), true);
    assert.deepEqual(store.following(), ['followed']);
});

test('the view shows the newest running turn of its own conversation', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('a', 'one', 'First');
    store.begin('b', 'two', 'Other conversation');
    store.begin('c', 'one', 'Second');
    assert.equal(store.live('one')!.id, 'c');
    assert.equal(store.live('two')!.id, 'b');
    assert.equal(store.live('three'), null);
});

test('the conversation the server saved a turn in replaces the page\'s guess at send', () => {
    const store = createTurnStepsStore(() => 0);
    // Sent while "New conversation" was still landing: the page still held the old id.
    store.begin('t', 'old', 'Sending');
    store.noteStep('t', step(1));
    store.noteStatus('t', { state: 'accepted', message: 'Received', conversation_id: 'new' });
    assert.equal(store.live('new')!.id, 't');
    assert.equal(store.live('new')!.steps.length, 1);
    assert.equal(store.live('old'), null);
    // A frame without the field leaves the binding alone.
    store.noteStatus('t', { state: 'running', message: 'Working' });
    assert.equal(store.live('new')!.id, 't');
});

test('every folded line stays expandable for the life of the page', () => {
    const store = createTurnStepsStore(() => 0);
    const turns = 1_000;
    for (let n = 0; n < turns; n += 1) {
        store.begin(`t${n}`, 'c', 'Working');
        store.noteStep(`t${n}`, step(1, { status: 'done', text: `Step of turn ${n}` }));
        store.fold(`t${n}`, `reply-${n}`);
    }
    assert.equal(store.getFolded().size, turns);
    assert.equal(store.getFolded().get('reply-0')!.steps[0].text, 'Step of turn 0');
    assert.equal(store.getFolded().get(`reply-${turns - 1}`)!.steps[0].text, `Step of turn ${turns - 1}`);
});

test('the status read completes a line that already folded and can only add to it', () => {
    let clock = 0;
    const store = createTurnStepsStore(() => clock);
    store.begin('t', 'c', 'Working');
    store.noteStep('t', step(1));
    clock = 7_000;
    store.fold('t', 'reply');
    assert.deepEqual(store.getFolded().get('reply')!.steps.map(s => s.status), ['unfinished']);
    assert.equal(store.getFolded().get('reply')!.durationMs, 7_000);

    store.completeFold('t', 'reply', { state: 'completed', steps: [step(1, { status: 'done' }), step(2, { status: 'done' })], step_count: 2, duration_ms: 5_000 });
    let line = store.getFolded().get('reply')!;
    assert.deepEqual(line.steps.map(s => [s.seq, s.status]), [[1, 'done'], [2, 'done']]);
    assert.equal(line.durationMs, 5_000);
    assert.equal(line.stepCount, 2);

    // An answer from before the turn ended cannot take anything back.
    store.completeFold('t', 'reply', { state: 'in_progress', steps: [step(1)], step_count: 1, duration_ms: null, elapsed_ms: 1_000 });
    line = store.getFolded().get('reply')!;
    assert.deepEqual(line.steps.map(s => [s.seq, s.status]), [[1, 'done'], [2, 'done']]);
    assert.equal(line.durationMs, 5_000);
    assert.equal(line.stepCount, 2);
});

test('the status read creates the line when the page held no steps, and an empty answer creates none', () => {
    const store = createTurnStepsStore(() => 0);
    store.completeFold('empty', 'no-line', { state: 'completed', steps: [], step_count: 0, duration_ms: 1_000 });
    assert.equal(store.getFolded().has('no-line'), false);
    store.completeFold('t', 'reply', { state: 'completed', steps: [step(1), step(2, { status: 'done' })], step_count: 2, duration_ms: 4_000 });
    const line = store.getFolded().get('reply')!;
    assert.deepEqual(line.steps.map(s => s.status), ['unfinished', 'done']);
    assert.equal(line.durationMs, 4_000);
    assert.equal(line.stepCount, 2);
});

test('the read pace is a fixed share of the allowance the API publishes', () => {
    const headers = (limit: string, policy: string) => new Headers({ 'RateLimit-Limit': limit, 'RateLimit-Policy': policy });
    assert.equal(followSpacingMs(headers('1000', '1000;w=60')), 960);
    assert.equal(followSpacingMs(headers('5758', '5758;w=900')), 2_501);
    // A halved allowance doubles the spacing, so a turn never spends more than its share.
    assert.equal(followSpacingMs(headers('2879', '2879;w=900')), 5_002);
    for (const absent of [undefined, null, new Headers(), headers('nonsense', 'nonsense'), headers('10', '10')]) {
        assert.equal(followSpacingMs(absent), 2_501, 'without a published allowance it uses the limiter\'s own');
    }
});

test('the store follows the last allowance published and ignores responses that publish none', () => {
    const store = createTurnStepsStore(() => 0);
    assert.equal(store.followSpacing(), followSpacingMs());
    store.noteAllowance(new Headers({ 'RateLimit-Limit': '1000', 'RateLimit-Policy': '1000;w=60' }));
    assert.equal(store.followSpacing(), 960);
    store.noteAllowance(new Headers());
    store.noteAllowance(null);
    assert.equal(store.followSpacing(), 960);
    store.resetForTests();
    assert.equal(store.followSpacing(), followSpacingMs());
});
