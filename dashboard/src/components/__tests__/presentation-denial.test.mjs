import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { TravelPresentationLauncher } from '../presentation/presentation-controller.tsx';

for (const deniedAction of ['wireless-picker', 'start']) {
  test(`Android ${deniedAction} permission denial shows the reason and leaves no authorized session`, async () => {
    const originalFetch = globalThis.fetch;
    window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
    const now = new Date(), commands = [], requests = [];
    const sourceDevice = { id: 'denied-phone', name: 'Android phone', platform: 'android' };
    const inventory = { version: 1, sourceDevice, observedAt: now.toISOString(),
      expiresAt: new Date(+now + 30000).toISOString(), status: 'available', limitations: [],
      targets: [{ id: 'attached', name: 'Attached display', sourceDeviceId: sourceDevice.id,
        method: 'android-presentation', availability: 'available', observedAt: now.toISOString(),
        capabilities: ['ambient'], limitations: [] }] };
    let sessions = [];
    window.ReactNativeWebView = { postMessage: raw => {
      const { command } = JSON.parse(raw); commands.push(command.action);
      const denied = command.action === deniedAction;
      const detail = denied ? { ok: false, code: 'permission_denied', message: 'Android denied permission to use this display.', state: 'failed' }
        : { ok: true, ...(command.action === 'discover' ? { inventory } : { state: 'stopped', sessionId: null }) };
      window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: command.requestId, ...detail } }));
    } };
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET' });
      if (url.endsWith('/sessions') && init.method === 'POST') {
        const selected = JSON.parse(init.body);
        assert.deepEqual(selected.view, { kind: 'ambient' });
        const created = { id: 'provisional', sourceDeviceId: sourceDevice.id, targetId: 'attached',
          method: 'android-presentation', view: selected.view, state: 'starting',
          createdAt: now.toISOString(), updatedAt: now.toISOString(),
          expiresAt: new Date(+now + 60000).toISOString(), reason: null };
        sessions = [created]; return Response.json(created);
      }
      if (url.endsWith('/provisional') && init.method === 'DELETE') {
        sessions = sessions.map(session => ({ ...session, state: 'stopped' })); return Response.json({});
      }
      return Response.json(url.endsWith('/config') ? { receiverOrigin: 'https://receiver.example' }
        : url.endsWith('/sessions') ? { sessions } : {});
    };
    const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
    try {
      await act(async () => root.render(createElement(TravelPresentationLauncher)));
      await act(async () => div.querySelector('button').click());
      if (deniedAction === 'start') await act(async () => document.querySelector('input[value="attached"]').click());
      const label = deniedAction === 'start' ? 'Present on selected display' : 'Connect with Cast';
      const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label);
      assert.ok(button);
      await act(async () => button.click());
      assert.ok(commands.includes(deniedAction));
      assert.equal(document.querySelector('[role="alert"]').textContent, 'Android denied permission to use this display.');
      assert.ok(!document.body.textContent.includes('Android confirmed'));
      assert.ok(!document.body.textContent.includes('Choose your TV in the native Cast picker, then enter'));
      assert.ok(!document.body.textContent.includes('https://receiver.example'));
      assert.ok(!requests.some(request => request.url.endsWith('/claim') || request.url.endsWith('/heartbeat')));
      if (deniedAction === 'start') {
        assert.ok(requests.some(request => request.method === 'DELETE' && request.url.endsWith('/provisional')));
        assert.deepEqual(sessions.map(session => session.state), ['stopped']);
      } else {
        assert.ok(!requests.some(request => request.method === 'POST' && request.url.endsWith('/sessions')));
        assert.deepEqual(sessions, []);
      }
    } finally {
      await act(async () => root.unmount()); div.remove(); globalThis.fetch = originalFetch;
      delete window.__NEXUS_DISPLAYS__; delete window.ReactNativeWebView;
    }
  });
}
