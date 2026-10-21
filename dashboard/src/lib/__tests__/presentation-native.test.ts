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
