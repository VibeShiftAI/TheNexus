import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_FOLDED_TURNS, MAX_HELD_STEPS, createTurnStepsStore, foldedLabel, formatElapsed, hiddenStepCount, isTurnStep,
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
    store.noteStatus('t', { state: 'running', message: 'Working' });
    store.noteStatus('t', { state: 'degraded', message: 'The fallback agent is taking this message.' });
    assert.equal(store.live('c')!.status, 'Working');
    assert.equal(store.live('c')!.warning, 'The fallback agent is taking this message.');
    store.noteStatus('t', { state: 'verifying', message: 'Checking the reply' });
    assert.equal(store.live('c')!.status, 'Checking the reply');
    assert.equal(store.live('c')!.warning, 'The fallback agent is taking this message.');
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

test('a very long turn discloses the steps this view no longer holds', () => {
    const store = createTurnStepsStore(() => 0);
    store.begin('t', 'c', 'Working');
    for (let seq = 1; seq <= MAX_HELD_STEPS + 3; seq += 1) store.noteStep('t', step(seq, { status: 'done' }));
    const turn = store.live('c')!;
    assert.equal(turn.steps.length, MAX_HELD_STEPS);
    assert.equal(turn.steps[0].seq, 4);
    assert.equal(hiddenStepCount(turn), 3);
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

test('folded turns are bounded in page memory', () => {
    const store = createTurnStepsStore(() => 0);
    for (let n = 0; n < MAX_FOLDED_TURNS + 2; n += 1) {
        store.begin(`t${n}`, 'c', 'Working');
        store.noteStep(`t${n}`, step(1, { status: 'done' }));
        store.fold(`t${n}`, `reply-${n}`);
    }
    assert.equal(store.getFolded().size, MAX_FOLDED_TURNS);
    assert.equal(store.getFolded().has('reply-0'), false);
    assert.equal(store.getFolded().has(`reply-${MAX_FOLDED_TURNS + 1}`), true);
});
