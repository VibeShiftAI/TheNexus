import test from 'node:test';
import assert from 'node:assert/strict';
import { readPraxisEventStream } from '../read-praxis-event-stream';

test('status frames report progress without becoming response text or a completed answer', async () => {
    const events = [{ type: 'status', state: 'queued', message: 'Waiting for the current reply.', turn_id: 'test-turn' },
        { type: 'delta', delta: 'Answer' }, { type: 'final', response: 'Answer' }];
    const response = new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    const deltas: string[] = [], statuses: any[] = [];
    const final = await readPraxisEventStream(response, d => deltas.push(d), s => statuses.push(s));
    assert.deepEqual(deltas, ['Answer']); assert.equal(statuses[0]?.state, 'queued'); assert.equal(final.response, 'Answer');
});
test('step frames arrive in order, apart from reply text, and a malformed one is ignored', async () => {
    const events = [{ type: 'step', id: 's1', seq: 1, kind: 'tool', text: 'Run git status', status: 'running', elapsed_ms: 900 },
        { type: 'step', id: 'bad', seq: 'x', kind: 'tool', text: 'Malformed', status: 'done' },
        { type: 'step', id: 's1', seq: 1, kind: 'tool', text: 'Run git status', status: 'done', elapsed_ms: 1400 },
        { type: 'delta', delta: 'Done' }, { type: 'final', response: 'Done', duration_ms: 1500, step_count: 1 }];
    const response = new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    const deltas: string[] = [], steps: any[] = [];
    const final = await readPraxisEventStream(response, d => deltas.push(d), undefined, s => steps.push(s));
    assert.deepEqual(steps.map(s => [s.id, s.status]), [['s1', 'running'], ['s1', 'done']]);
    assert.deepEqual(deltas, ['Done']);
    assert.equal(final.duration_ms, 1500);
});
test('status-only disconnect never confirms completion', async () => {
    const statuses: any[] = [];
    await assert.rejects(readPraxisEventStream(new Response('data: {"type":"status","state":"accepted","message":"Received"}\n\n'),
        () => assert.fail('No model text was received'), s => statuses.push(s)), /before completion/);
    assert.equal(statuses.length, 1);
});
