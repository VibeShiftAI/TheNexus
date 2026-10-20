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
