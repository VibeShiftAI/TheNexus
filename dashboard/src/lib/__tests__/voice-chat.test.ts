import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../voice-chat';
const turn = { clientMessageId: 'stable-turn', message: 'schedule tomorrow', conversationId: 'selected', history: [{ role: 'user', content: 'typed context' }], projectId: 'project' };
const receipt = (status = 'pending') => ({ accepted: true, clientMessageId: turn.clientMessageId, conversationId: 'selected', status, ...(status === 'completed' ? { response: 'The complete eventual answer.', assistantMessageId: 'stable-turn:reply' } : {}) });
const signal = () => new AbortController().signal;
const tick = () => new Promise(resolve => setImmediate(resolve));
function sender() { assert.equal(typeof api.sendVoiceChat, 'function', 'durable voice chat sender exists'); return api.sendVoiceChat; }

test('lost acceptance reconciles by exact ID and transient receipt failures never resend accepted work', async () => {
  const send = sender(); const calls: { url: string; body: any }[] = []; const phases: string[] = []; let gets = 0;
  const result = await send(turn, { signal: signal(), pollIntervalMs: 1, onProgress: phase => phases.push(phase), fetch: async (url, init) => {
    calls.push({ url: String(url), body: init?.body && JSON.parse(String(init.body)) });
    if (init?.method === 'POST') throw new TypeError('response lost after acceptance');
    if (++gets === 1) return Response.json(receipt());
    if (gets === 2) return Response.json({ error: 'temporary proxy outage' }, { status: 502 });
    if (gets === 3) throw new TypeError('offline');
    return Response.json(receipt('completed'));
  } });
  assert.equal(result.response, 'The complete eventual answer.');
  assert.equal(calls.filter(c => c.body).length, 1);
  assert.deepEqual(calls[0].body, { ...turn, async: true, voiceConversation: true });
  assert.ok(calls.slice(1).every(c => c.url === '/api/ai/chat/requests/stable-turn'));
  for (const phase of ['accepted', 'working', 'reconnecting']) assert.ok(phases.includes(phase));
});
test('an ambiguous unsaved acceptance retries with the same ID and body', async () => {
  const send = sender(); const posts: unknown[] = []; let gets = 0;
  const result = await send(turn, { signal: signal(), pollIntervalMs: 1, fetch: async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); if (posts.length === 1) throw new Error('offline'); return Response.json(receipt(), { status: 202 }); }
    return ++gets === 1 ? Response.json({ accepted: false, status: 'not_found' }, { status: 404 }) : Response.json(receipt('completed'));
  } });
  assert.equal(result.status, 'completed'); assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
});
test('accepted work survives a later missing receipt without being posted again', async () => {
  const send = sender(); let posts = 0; let gets = 0;
  await send(turn, { signal: signal(), pollIntervalMs: 1, fetch: async (_url, init) => {
    if (init?.method === 'POST') { posts++; return Response.json(receipt(), { status: 202 }); }
    return ++gets === 1 ? Response.json({ status: 'not_found' }, { status: 404 }) : Response.json(receipt('completed'));
  } });
  assert.equal(posts, 1);
});
test('interrupted and failed accepted receipts convey uncertainty without reexecution', async () => {
  const send = sender();
  for (const status of ['interrupted', 'failed']) {
    let calls = 0;
    await assert.rejects(send(turn, { signal: signal(), fetch: async () => { calls++; return Response.json({ ...receipt(status), error: 'upstream timeout' }); } }), /saved chat.*before.*resend/i);
    assert.equal(calls, 1);
  }
});
test('ending voice aborts hung acceptance and cleans its timer and abort listener', async t => {
  const send = sender(); const controller = new AbortController(); let requestSignal!: AbortSignal;
  const add = t.mock.method(controller.signal, 'addEventListener'); const remove = t.mock.method(controller.signal, 'removeEventListener');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const result = send(turn, { signal: controller.signal, requestTimeoutMs: 1000, fetch: async (_url, init) => { requestSignal = init!.signal!; return new Promise(() => {}); } });
  await tick(); controller.abort(); await assert.rejects(result, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true); assert.equal(add.mock.callCount(), remove.mock.callCount()); assert.ok(clear.mock.callCount() > 0);
});
test('short request timeout includes a stalled body and eventually reconnects', async () => {
  const send = sender(); let gets = 0; let postSignal!: AbortSignal;
  const result = await send(turn, { signal: signal(), requestTimeoutMs: 5, pollIntervalMs: 1, fetch: async (_url, init) => {
    if (init?.method === 'POST') { postSignal = init.signal!; return { ok: true, status: 202, json: () => new Promise(() => {}) } as Response; }
    gets++; return Response.json(receipt('completed'));
  } });
  assert.equal(result.status, 'completed'); assert.equal(postSignal.aborted, true); assert.equal(gets, 1);
});
test('permanent acceptance rejection is shown without retrying', async () => {
  const send = sender(); let calls = 0;
  await assert.rejects(send(turn, { signal: signal(), fetch: async () => { calls++; return Response.json({ error: 'Conversation not found' }, { status: 404 }); } }), /Conversation not found/);
  assert.equal(calls, 1);
});
test('local archival retries only storage with stable IDs and voice ownership', async () => {
  assert.equal(typeof api.archiveVoiceExchange, 'function'); const bodies: any[] = [];
  const rows = await api.archiveVoiceExchange(turn, 'On screen. Task board.', { pollIntervalMs: 1, fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new Error('lost sync acknowledgment');
    return Response.json({ ok: true, synced: 2, conversationId: 'selected', messages: bodies.at(-1).messages });
  } });
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(rows.length, 2);
  assert.equal(bodies[0].conversationId, 'selected'); assert.equal(rows[0].id, 'stable-turn'); assert.equal(rows[1].id, 'stable-turn:reply');
  assert.equal(rows[1].metadata.playbackOwner, 'voice');
});
test('a non-JSON permanent HTTP rejection does not reconnect forever', async () => {
  let calls = 0;
  await assert.rejects(api.sendVoiceChat(turn, { signal: AbortSignal.timeout(25), pollIntervalMs: 1, fetch: async () => { calls++; return new Response('<html>Unauthorized</html>', { status: 401 }); } }), /rejected/i);
  assert.equal(calls, 1);
});
test('receipt recovery puts the missing earlier user before an already delivered reply and deduplicates receipt IDs', () => {
  const reply = { id: 'stable-turn:reply', role: 'assistant' as const, content: 'reply', timestamp: new Date('2026-09-08T12:01:00Z') };
  const user = { id: 'stable-turn', role: 'user' as const, content: 'question', created_at: '2026-09-08T12:00:00Z' };
  const result = api.mergeVoiceMessages([reply], [user, user, { ...reply, created_at: reply.timestamp.toISOString() }]);
  assert.deepEqual(result.map(row => row.id), ['stable-turn', 'stable-turn:reply']);
});
