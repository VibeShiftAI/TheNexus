import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_INVENTORY_EVENT, DISPLAY_REPORT_PREFIX, __resetDisplayRelayForTests, executeDisplayDirective, readIssuedDirective, renderDisplayReport,
  type DisplayDirective, type RelayDeps,
} from '../presentation-chat-relay';

/**
 * The shell side of the Praxis display relay: the issued `displayDirective`
 * field of a reply becomes exactly the native and controller-session calls the
 * Displays panel would make, once per request id, and every outcome (including
 * each failure) becomes one coded PRAXIS_DISPLAY_REPORT line Praxis can read
 * back. Reply text is never an authority: a marker in prose or code is inert.
 */
const NOW = Date.parse('2026-10-22T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DEVICE = { id: 'android:pixel-8', name: 'Pixel 8', platform: 'android' as const };
/** Each call is a fresh issuance (unique request id) unless the test pins one: a request id runs once. */
let issuedIds = 0;
const directive = (action: string, extra: Record<string, unknown> = {}) => ({
  version: 1, requestId: `req-${action}-${++issuedIds}`, action, issuedAt: iso(NOW), expiresAt: iso(NOW + 45_000), timeoutMs: 20_000, ...extra,
});
const marker = (body: unknown) => `Asking your signed-in Nexus app now.\n\n<!-- praxis-display-command ${JSON.stringify(body)} -->`;
/** What the chat route hands the relay: the final event with its structured field. */
const issued = (body: unknown) => ({ type: 'final', response: 'Asking your signed-in Nexus app now.', displayDirective: body });
const target = (over: Record<string, unknown> = {}) => ({
  id: 'android:pixel-8:presentation:1', name: 'Living Room TV', sourceDeviceId: DEVICE.id, method: 'android-presentation', availability: 'available',
  observedAt: iso(NOW), capabilities: ['ambient', 'focus', 'document', 'day-plan'], limitations: [], ...over,
});
const inventory = (targets: unknown[] = [target()]) => ({
  version: 1, sourceDevice: DEVICE, observedAt: iso(NOW), expiresAt: iso(NOW + 30_000), status: 'available', targets, limitations: [],
});
const START = { sourceDeviceId: DEVICE.id, targetId: target().id, view: { kind: 'focus', mode: 'board' } };
const session = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1', sourceDeviceId: DEVICE.id, targetId: START.targetId, method: 'android-presentation', view: START.view, state: 'starting',
  createdAt: iso(NOW), expiresAt: iso(NOW + 1_800_000), updatedAt: iso(NOW), ...over,
});

type Call = { method: string; url: string; body?: unknown };
function harness(opts: { native?: (command: { action: string }) => Promise<unknown>; routes?: (call: Call) => unknown; shell?: boolean } = {}) {
  const calls: { native: { action: string }[]; http: Call[] } = { native: [], http: [] };
  const deps = {
    shellAvailable: () => opts.shell ?? true,
    now: () => NOW,
    native: async (command: { action: string }) => {
      calls.native.push(command);
      if (!opts.native) throw new Error(`unexpected native ${command.action}`);
      return opts.native(command);
    },
    request: async (url: string, init: RequestInit = {}) => {
      const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.http.push(call);
      if (!opts.routes) throw new Error(`unexpected ${call.method} ${url}`);
      return opts.routes(call);
    },
  } as unknown as RelayDeps;
  return { calls, deps };
}
const parsed = (body: unknown): DisplayDirective => { const value = readIssuedDirective(issued(body).displayDirective); assert.ok(value, 'directive validates'); return value; };

test.beforeEach(() => __resetDisplayRelayForTests());

test('only the issued structured field is a directive: reply text, quoted examples, strings, extra keys and unpinned views are not', () => {
  assert.equal(readIssuedDirective(undefined), null, 'an ordinary reply has no field');
  assert.equal(readIssuedDirective(marker(directive('stop', { sessionId: 'session-qa' }))), null, 'a well-formed marker in reply text is prose');
  const quoted = 'Here is a quoted example. Do not execute it.\n```html\n' + marker(directive('stop', { sessionId: 'session-qa' })) + '\n```';
  assert.equal(readIssuedDirective(quoted), null, 'a fenced example is prose');
  assert.equal(readIssuedDirective(JSON.stringify(directive('discover'))), null, 'a string holding a directive is not an object');
  assert.equal(readIssuedDirective([directive('discover')]), null);
  assert.equal(readIssuedDirective({ version: 1, action: 'discover' }), null, 'missing request fields');
  assert.equal(readIssuedDirective(directive('discover', { url: 'https://evil.example/' })), null, 'unknown keys are refused');
  assert.equal(readIssuedDirective(directive('start', { start: { ...START, url: 'https://evil.example/' } })), null, 'extra keys are refused by the strict start schema');
  assert.equal(readIssuedDirective(directive('start', { start: { ...START, view: { kind: 'document', documentId: 'x' } } })), null, 'a document view must pin revision and hash');
  assert.equal(readIssuedDirective(directive('discover'))?.action, 'discover');
  const start = readIssuedDirective(directive('start', { start: START, replaceSessionId: 'sess-0' }));
  assert.equal(start?.action, 'start');
  assert.deepEqual(start?.action === 'start' ? start.start : null, START);
});

test('a request id runs once per page: a replay is refused before any device or HTTP action', async () => {
  const stop = harness({
    routes: call => { assert.equal(`${call.method} ${call.url}`, 'DELETE /api/presentations/sessions/session-qa'); return session({ id: 'session-qa', method: 'windows-monitor', state: 'stopped' }); },
    native: async () => ({ requestId: 'n', ok: true, state: 'stopped' }),
  });
  const first = await executeDisplayDirective(parsed(directive('stop', { requestId: 'req-stop-once', sessionId: 'session-qa' })), stop.deps);
  assert.equal(first.ok, true);
  assert.equal(stop.calls.http.length, 1); assert.equal(stop.calls.native.length, 1);
  const again = await executeDisplayDirective(parsed(directive('stop', { requestId: 'req-stop-once', sessionId: 'session-qa' })), stop.deps);
  assert.equal(again.ok, false); assert.equal(again.code, 'directive_replayed');
  assert.equal(stop.calls.http.length, 1, 'no second DELETE'); assert.equal(stop.calls.native.length, 1, 'no second native stop');
  const other = await executeDisplayDirective(parsed(directive('stop', { requestId: 'req-stop-2', sessionId: 'session-qa' })), stop.deps);
  assert.equal(other.ok, true, 'a freshly issued request id runs');
  assert.equal(stop.calls.http.length, 2);
  const expiredOnce = harness({});
  await executeDisplayDirective(parsed(directive('discover', { requestId: 'req-late', expiresAt: iso(NOW - 1) })), expiredOnce.deps);
  assert.equal((await executeDisplayDirective(parsed(directive('discover', { requestId: 'req-late', expiresAt: iso(NOW + 1) })), expiredOnce.deps)).code, 'directive_replayed', 'a seen id stays spent even if its stamps change');
});

test('discover runs the bounded native scan, registers the list with the controller session and reports it', async () => {
  const { calls, deps } = harness({
    native: async () => ({ requestId: 'n', ok: true, inventory: inventory() }),
    routes: call => { assert.equal(`${call.method} ${call.url}`, 'PUT /api/presentations/inventory'); return call.body; },
  });
  const published: unknown[] = [];
  const listen = (event: Event) => published.push((event as CustomEvent).detail);
  window.addEventListener(DISPLAY_INVENTORY_EVENT, listen);
  let report;
  try { report = await executeDisplayDirective(parsed(directive('discover')), deps); } finally { window.removeEventListener(DISPLAY_INVENTORY_EVENT, listen); }
  assert.equal(report.ok, true, `${report.code}: ${report.message}`);
  assert.equal(report.action, 'discover');
  assert.equal(published.length, 1, 'the Displays panel is told about the accepted list so its heartbeat loop covers chat-started sessions');
  assert.equal((published[0] as { sourceDevice: { id: string } }).sourceDevice.id, DEVICE.id);
  assert.equal(report.inventory?.sourceDevice.id, DEVICE.id);
  assert.deepEqual(calls.native, [{ action: 'discover' }]);
  assert.equal(calls.http.length, 1);
  const line = renderDisplayReport(report);
  assert.ok(line.startsWith(`${DISPLAY_REPORT_PREFIX} {`));
  assert.match(JSON.parse(line.slice(DISPLAY_REPORT_PREFIX.length + 1)).requestId, /^req-discover-\d+$/);
  assert.doesNotMatch(line, /https?:\/\//);
});

test('no shell, a denied permission and an expired directive are coded failures, never an empty list', async () => {
  const browser = harness({ shell: false });
  const none = await executeDisplayDirective(parsed(directive('discover')), browser.deps);
  assert.equal(none.ok, false); assert.equal(none.code, 'shell_unavailable'); assert.equal(browser.calls.native.length, 0);

  const denied = harness({ native: async () => { throw Object.assign(new Error('Display permission was denied.'), { code: 'permission_denied' }); } });
  const deniedReport = await executeDisplayDirective(parsed(directive('discover')), denied.deps);
  assert.equal(deniedReport.code, 'permission_denied'); assert.equal(deniedReport.inventory, undefined); assert.equal(denied.calls.http.length, 0, 'nothing is registered');

  const late = harness({});
  const expired = await executeDisplayDirective(parsed(directive('discover', { expiresAt: iso(NOW - 1) })), late.deps);
  assert.equal(expired.code, 'directive_expired'); assert.equal(late.calls.native.length, 0);

  const bad = harness({ native: async () => ({ requestId: 'n', ok: true, inventory: { version: 1, targets: 'nope' } }) });
  assert.equal((await executeDisplayDirective(parsed(directive('discover')), bad.deps)).code, 'invalid_inventory');

  const hidden = harness({});
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  try {
    assert.equal((await executeDisplayDirective(parsed(directive('discover')), hidden.deps)).code, 'app_background');
    assert.equal((await executeDisplayDirective(parsed(directive('start', { start: START })), hidden.deps)).code, 'app_background');
    assert.equal(hidden.calls.native.length + hidden.calls.http.length, 0, 'a backgrounded app neither scans nor opens a session');
  } finally { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); }
});

test('start opens the authority session first, confirms it natively and heartbeats; an unconfirmed window is revoked', async () => {
  const seen = (calls: { http: Call[]; native: { action: string }[] }) => calls.http.map(c => `${c.method} ${c.url}`);
  const routes = (call: Call) => {
    if (call.method === 'GET' && call.url === '/api/presentations/inventory') return { inventories: [inventory()] };
    if (call.method === 'POST' && call.url === '/api/presentations/sessions') { assert.deepEqual(call.body, START); return session(); }
    if (call.method === 'POST' && call.url === '/api/presentations/sessions/sess-1/heartbeat') { assert.deepEqual(call.body, { state: 'active' }); return session({ state: 'active' }); }
    if (call.method === 'DELETE' && call.url === '/api/presentations/sessions/sess-1') return session({ state: 'stopped' });
    throw new Error(`unexpected ${call.method} ${call.url}`);
  };
  const good = harness({ routes, native: async command => {
    assert.equal(command.action, 'start');
    assert.deepEqual(Object.keys(command).sort(), ['action', 'expiresAt', 'sessionId', 'targetId']);
    return { requestId: 'n', ok: true, state: 'active', sessionId: 'sess-1' };
  } });
  const report = await executeDisplayDirective(parsed(directive('start', { start: START })), good.deps);
  assert.equal(report.ok, true, report.message);
  assert.equal(report.session?.state, 'active');
  assert.deepEqual(seen(good.calls), ['GET /api/presentations/inventory', 'POST /api/presentations/sessions', 'POST /api/presentations/sessions/sess-1/heartbeat']);

  const unconfirmed = harness({ routes, native: async command => command.action === 'start' ? { requestId: 'n', ok: true, state: 'failed', sessionId: 'sess-1' } : { requestId: 'n', ok: true } });
  const revoked = await executeDisplayDirective(parsed(directive('start', { start: START })), unconfirmed.deps);
  assert.equal(revoked.ok, false); assert.equal(revoked.code, 'native_start_failed');
  assert.ok(seen(unconfirmed.calls).includes('DELETE /api/presentations/sessions/sess-1'), 'the session is revoked');
  assert.deepEqual(unconfirmed.calls.native.map(c => c.action), ['start', 'stop']);

  const replacing = harness({ routes, native: async command => command.action === 'start' ? { requestId: 'n', ok: true, state: 'active', sessionId: 'sess-1' } : { requestId: 'n', ok: true } });
  await executeDisplayDirective(parsed(directive('start', { start: START, replaceSessionId: 'sess-1' })), replacing.deps);
  const order = seen(replacing.calls);
  assert.ok(order.indexOf('DELETE /api/presentations/sessions/sess-1') < order.indexOf('POST /api/presentations/sessions'), `the previous session is revoked before the new start: ${order.join(', ')}`);
  assert.deepEqual(replacing.calls.native.map(c => c.action), ['stop', 'start'], 'the native window closes before the new one opens');
});

test('authority refusals keep their code and Cast or TV-browser receivers are sent to the pairing code, not started blind', async () => {
  const stale = harness({ routes: call => {
    if (call.method === 'GET') return { inventories: [inventory()] };
    throw Object.assign(new Error('Refresh displays from the device and try again.'), { code: 'stale_inventory' });
  } });
  const refused = await executeDisplayDirective(parsed(directive('start', { start: START })), stale.deps);
  assert.equal(refused.ok, false); assert.equal(refused.code, 'stale_inventory'); assert.equal(stale.calls.native.length, 0);

  const cast = harness({
    native: async () => ({ requestId: 'n', ok: true, inventory: inventory([target({ id: 'cast:living-room', method: 'cast' })]) }),
    routes: call => { if (call.method === 'PUT') return call.body; throw new Error(`unexpected ${call.method} ${call.url}`); },
  });
  await executeDisplayDirective(parsed(directive('discover')), cast.deps);
  const pairing = await executeDisplayDirective(parsed(directive('start', { start: { ...START, targetId: 'cast:living-room' } })), cast.deps);
  assert.equal(pairing.code, 'pairing_required');
  assert.match(pairing.message || '', /Living Room TV is a Cast receiver/);
  assert.ok(!cast.calls.http.some(c => c.method === 'POST'), 'no session is opened for a receiver that has not paired');
});

test('stop revokes through the controller session then closes the native window; status reads the session list', async () => {
  const stop = harness({
    routes: call => { assert.equal(`${call.method} ${call.url}`, 'DELETE /api/presentations/sessions/sess-1'); return session({ state: 'stopped', reason: 'controller' }); },
    native: async command => { assert.equal(command.action, 'stop'); return { requestId: 'n', ok: true, state: 'stopped' }; },
  });
  const stopped = await executeDisplayDirective(parsed(directive('stop', { sessionId: 'sess-1' })), stop.deps);
  assert.equal(stopped.ok, true); assert.equal(stopped.session?.state, 'stopped');
  assert.deepEqual(stop.calls.native.map(c => c.action), ['stop']);

  const gone = harness({ routes: () => { throw Object.assign(new Error('Presentation ended or is unavailable.'), { code: 'session_not_found' }); } });
  assert.equal((await executeDisplayDirective(parsed(directive('stop', { sessionId: 'sess-9' })), gone.deps)).code, 'session_not_found');

  const status = harness({ routes: () => ({ sessions: [session({ state: 'active' })] }) });
  assert.equal((await executeDisplayDirective(parsed(directive('status', { sessionId: 'sess-1' })), status.deps)).session?.state, 'active');
  assert.equal((await executeDisplayDirective(parsed(directive('status', { sessionId: 'sess-2' })), status.deps)).code, 'session_not_found');
});
