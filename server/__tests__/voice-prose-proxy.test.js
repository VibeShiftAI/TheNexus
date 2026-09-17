const { EventEmitter } = require('events');
jest.mock('../services/praxis-client', () => ({
  praxisFetch: jest.fn(), praxisProxyJson: jest.fn(),
  praxisStream: jest.fn(() => Object.assign(new (require('events').EventEmitter)(), { destroy() {} })),
}));
const { praxisFetch } = require('../services/praxis-client');
let router;
beforeEach(() => { router = require('../routes/praxis-stream')(); });
afterEach(() => { router.closeUpstream(); jest.useRealTimers(); jest.clearAllMocks(); });
function post(body) {
  const route = router.stack.find(layer => layer.route?.path === '/voice-prose')?.route;
  expect(route).toBeDefined();
  const req = Object.assign(new EventEmitter(), { body, method: 'POST' });
  const res = Object.assign(new EventEmitter(), { code: 200, headers: {}, status(code) { this.code = code; return this; }, setHeader(k,v) { this.headers[k] = v; }, json(body) { this.body = body; return this; } });
  return { res, done: route.stack[0].handle(req, res) };
}
test('valid prose requests preserve facts and freshly call the sole writer each time', async () => {
  praxisFetch.mockResolvedValueOnce(Response.json({ text: 'Fresh first.' })).mockResolvedValueOnce(Response.json({ text: 'Fresh second.' }));
  const one = post({ kind: 'alert', facts: { status: 'failed', reason: 'Compiler error' } }); await one.done;
  const two = post({ kind: 'voice-test', facts: 'Check audibility', maxWords: 20 }); await two.done;
  expect(one.res.body).toEqual({ text: 'Fresh first.' }); expect(two.res.body).toEqual({ text: 'Fresh second.' });
  expect(praxisFetch).toHaveBeenCalledTimes(2);
  expect(praxisFetch.mock.calls[0][0]).toBe('/api/voice/prose');
  expect(JSON.parse(praxisFetch.mock.calls[0][1].body)).toEqual({ kind: 'alert', facts: { status: 'failed', reason: 'Compiler error' }, maxWords: 80 });
  expect(praxisFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(one.res.headers['Cache-Control']).toBe('no-store');
});
test.each([
  {}, { kind: 'invalid', facts: {} }, { kind: 'alert', facts: [] }, { kind: 'alert', facts: null },
  { kind: 'alert', facts: 'x'.repeat(11999) }, { kind: 'alert', facts: 'x'.repeat(12001) }, { kind: 'alert', facts: { text: 'x'.repeat(12000) } },
  ...[19, 301, 20.5, '80'].map(maxWords => ({ kind: 'voice-test', facts: {}, maxWords })),
])('invalid prose request returns 400 without contacting the writer (case %#)', async body => {
  const result = post(body); await result.done; expect(result.res.code).toBe(400); expect(praxisFetch).not.toHaveBeenCalled();
});
test.each(['command-result','alert','voice-test','schedule-approved','morning-prep','status-ready','chat-reply','demo-mode','away-briefing'])('accepts kind %s', async kind => {
  praxisFetch.mockResolvedValue(Response.json({ text: 'Fresh words.' }));
  const result = post({ kind, facts: 'x'.repeat(11998), maxWords: 300 }); await result.done; expect(result.res.code).toBe(200);
});
test.each([Response.json({ text: '' }), Response.json({ response: 'wrong shape' }), Response.json({ error: 'offline' }, { status: 503 })])('upstream failure or missing prose is silent 503 with no retry', async response => {
  praxisFetch.mockResolvedValue(response); const result = post({ kind: 'alert', facts: {} }); await result.done;
  expect(result.res.code).toBe(503); expect(result.res.body.text).toBeUndefined(); expect(praxisFetch).toHaveBeenCalledTimes(1);
});
test.each(['headers', 'body'])('bounds stalled %s to 35 seconds and aborts the actual upstream request', async phase => {
  jest.useFakeTimers();
  praxisFetch.mockImplementation(() => phase === 'headers' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
  const result = post({ kind: 'alert', facts: {} });
  await jest.advanceTimersByTimeAsync(35000); await result.done;
  expect(result.res.code).toBe(503); expect(praxisFetch.mock.calls[0][1].signal.aborted).toBe(true); expect(praxisFetch).toHaveBeenCalledTimes(1);
});

test('disconnecting the client aborts the writer and cleans the deadline', async () => {
  jest.useFakeTimers(); praxisFetch.mockImplementation(() => new Promise(() => {}));
  const result = post({ kind: 'voice-test', facts: {} });
  result.res.destroyed = true; result.res.emit('close'); await result.done;
  expect(praxisFetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(result.res.body).toBeUndefined(); expect(result.res.listenerCount('close')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});
test('transport failure returns text-only 503 without retrying', async () => {
  praxisFetch.mockRejectedValue(new Error('offline'));
  const result = post({ kind: 'voice-test', facts: {} }); await result.done;
  expect(result.res.code).toBe(503); expect(result.res.body.text).toBeUndefined(); expect(praxisFetch).toHaveBeenCalledTimes(1);
});
