import test from 'node:test';
import assert from 'node:assert/strict';
import { displayShellAvailable, requestNativeDisplay } from '../presentation-native';

test('browser and unsupported shells have no display launcher', () => {
  delete window.__NEXUS_DISPLAYS__;
  assert.equal(displayShellAvailable(), false);
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'windows' };
  assert.equal(displayShellAvailable(), true);
  delete window.__NEXUS_DISPLAYS__;
});

test('native requests correlate replies and send only the bounded action payload', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'windows' };
  try {
    const result = await requestNativeDisplay({ action: 'discover' }, { navigate: url => {
      const message = JSON.parse(new URL(url).searchParams.get('request')!);
      assert.equal(message.action, 'discover');
      assert.ok(message.requestId);
      window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: 'other', ok: false } }));
      window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: message.requestId, ok: true, state: 'stopped' } }));
    } });
    assert.equal(result.state, 'stopped');
    await assert.rejects(requestNativeDisplay({ action: 'status' }, { navigate: () => {}, timeoutMs: 2 }), /did not respond/);
  } finally { delete window.__NEXUS_DISPLAYS__; }
});

test('Android uses the native message bridge and correlates replies without navigation', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
  const navigate = () => assert.fail('Android must not use the Windows command scheme');
  window.ReactNativeWebView = { postMessage: raw => {
    const message = JSON.parse(raw);
    assert.equal(message.type, 'presentation');
    assert.deepEqual(Object.keys(message.command).sort(), ['action', 'requestId']);
    assert.equal(message.command.action, 'wireless-picker');
    window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: message.command.requestId, ok: true } }));
  } };
  try {
    assert.equal(displayShellAvailable(), true);
    assert.equal((await requestNativeDisplay({ action: 'wireless-picker' }, { navigate })).ok, true);
  } finally { delete window.__NEXUS_DISPLAYS__; delete window.ReactNativeWebView; }
});

test('Android without an installed native transport fails honestly', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
  delete window.ReactNativeWebView;
  try { await assert.rejects(requestNativeDisplay({ action: 'discover' }), /Android.*bridge/i); }
  finally { delete window.__NEXUS_DISPLAYS__; }
});

test('scoped teardown checks native identity and serializes a newer start behind the check and stop', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'windows' };
  let active: string | null = 'old';
  let releaseStatus!: () => void;
  let statusSeen!: () => void;
  const checked = new Promise<void>(resolve => { statusSeen = resolve; });
  const calls: string[] = [];
  const navigate = (url: string) => {
    const command = JSON.parse(new URL(url).searchParams.get('request')!);
    calls.push(command.action);
    const reply = () => window.dispatchEvent(new window.CustomEvent('nexus:display-result', {
      detail: { requestId: command.requestId, ok: true, sessionId: active, state: active ? 'active' : 'stopped' },
    }));
    if (command.action === 'status') { releaseStatus = reply; statusSeen(); return; }
    if (command.action === 'stop') active = null;
    if (command.action === 'start') active = command.sessionId;
    reply();
  };
  try {
    const stop = requestNativeDisplay({ action: 'stop', sessionId: 'old' }, { navigate });
    // Bound the red run too: the old implementation issues stop without a status check.
    await Promise.race([checked, stop]);
    assert.deepEqual(calls, ['status']);
    const start = requestNativeDisplay({ action: 'start', sessionId: 'new', targetId: 'screen', expiresAt: new Date(Date.now() + 60_000).toISOString() }, { navigate });
    await Promise.resolve();
    assert.deepEqual(calls, ['status'], 'start cannot overtake the pending session check');
    releaseStatus();
    await Promise.all([stop, start]);
    assert.deepEqual(calls, ['status', 'stop', 'start']);
    assert.equal(active, 'new');
    const lateStop = requestNativeDisplay({ action: 'stop', sessionId: 'old' }, { navigate });
    await new Promise(resolve => setImmediate(resolve));
    releaseStatus();
    await lateStop;
    assert.equal(active, 'new', 'a stale stop never closes the new output');
    assert.deepEqual(calls, ['status', 'stop', 'start', 'status']);
  } finally { delete window.__NEXUS_DISPLAYS__; }
});
