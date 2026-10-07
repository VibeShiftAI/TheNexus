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
test('status-only disconnect never confirms completion', async () => {
    const statuses: any[] = [];
    await assert.rejects(readPraxisEventStream(new Response('data: {"type":"status","state":"accepted","message":"Received"}\n\n'),
        () => assert.fail('No model text was received'), s => statuses.push(s)), /before completion/);
    assert.equal(statuses.length, 1);
});
