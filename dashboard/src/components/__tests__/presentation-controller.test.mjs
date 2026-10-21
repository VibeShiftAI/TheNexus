import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { TravelPresentationLauncher, PresentDocumentButton } from '../presentation/presentation-controller.tsx';

test('neither the global launcher nor exact-review button renders in a standalone browser', async () => {
  delete window.__NEXUS_DISPLAYS__;
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement('div', {}, createElement(TravelPresentationLauncher), createElement(PresentDocumentButton, { documentId: 'd', revisionId: 'r', contentHash: 'a'.repeat(64) }))));
    assert.equal(div.textContent, '');
  } finally { act(() => root.unmount()); div.remove(); }
});

test('document controller button relays the exact displayed revision, never asks for latest', async () => {
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'windows' };
  let selected; const receive = event => { selected = event.detail; };
  window.addEventListener('nexus:present-document', receive);
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(PresentDocumentButton, { documentId: 'doc', revisionId: 'older-revision', contentHash: 'a'.repeat(64) })));
    act(() => div.querySelector('button').click());
    assert.deepEqual(selected, { kind: 'document', documentId: 'doc', revisionId: 'older-revision', contentHash: 'a'.repeat(64) });
  } finally { act(() => root.unmount()); div.remove(); window.removeEventListener('nexus:present-document', receive); delete window.__NEXUS_DISPLAYS__; }
});

test('Android discovers its own source, starts the selected view and revokes on background', async () => {
  const originalFetch = globalThis.fetch;
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
  const sourceDevice = { id: 'phone-1', name: 'Android phone', platform: 'android' };
  const now = new Date();
  const inventory = { version: 1, sourceDevice, observedAt: now.toISOString(), expiresAt: new Date(+now + 30000).toISOString(), status: 'available', limitations: [], targets: [{ id: 'display-2', name: 'External display', sourceDeviceId: 'phone-1', method: 'android-presentation', availability: 'available', observedAt: now.toISOString(), capabilities: ['ambient', 'focus', 'document', 'day-plan'], limitations: [] }] };
  let sessions = []; const requests = [], commands = [];
  window.ReactNativeWebView = { postMessage: raw => {
    const { command } = JSON.parse(raw); commands.push(command);
    const detail = command.action === 'discover' ? { inventory } : command.action === 'start' ? { state: 'active', sessionId: command.sessionId } : { state: 'stopped', sessionId: null };
    window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: command.requestId, ok: true, ...detail } }));
  } };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method || 'GET', body });
    let data = {};
    if (url.endsWith('/config')) data = { receiverOrigin: null };
    else if (url.endsWith('/sessions') && init.method === 'POST') {
      assert.deepEqual(body, { sourceDeviceId: 'phone-1', targetId: 'display-2', view: { kind: 'ambient' } });
      data = { id: 'session-1', sourceDeviceId: 'phone-1', targetId: 'display-2', method: 'android-presentation', view: body.view, state: 'starting', createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(+now + 60000).toISOString(), reason: null };
      sessions = [data];
    } else if (url.endsWith('/sessions')) data = { sessions };
    else if (init.method === 'DELETE') sessions = sessions.map(s => ({ ...s, state: 'stopped' }));
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(TravelPresentationLauncher)));
    await act(async () => div.querySelector('button').click());
    const target = document.querySelector('input[value="display-2"]'); assert.ok(target);
    await act(async () => target.click());
    const start = [...document.querySelectorAll('button')].find(b => b.textContent === 'Present on selected display');
    await act(async () => start.click());
    assert.ok(commands.some(c => c.action === 'start' && c.sessionId === 'session-1'));
    assert.ok(document.body.textContent.includes('Android confirmed'));
    const picker = [...document.querySelectorAll('button')].find(b => b.textContent === 'Choose wireless display');
    assert.ok(picker);
    await act(async () => picker.click());
    assert.ok(commands.some(c => c.action === 'wireless-picker'));
    await act(async () => window.dispatchEvent(new window.CustomEvent('nexus:display-background')));
    assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith('/session-1')));
    assert.ok(commands.some(c => c.action === 'stop'));
  } finally { await act(async () => root.unmount()); div.remove(); globalThis.fetch = originalFetch; delete window.__NEXUS_DISPLAYS__; delete window.ReactNativeWebView; }
});

test('backgrounding during pairing revokes the returned session even when the following refresh fails', async () => {
  const originalFetch = globalThis.fetch;
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
  const now = new Date(), requests = [];
  const sourceDevice = { id: 'phone-race', name: 'Android phone', platform: 'android' };
  const inventory = { version: 1, sourceDevice, observedAt: now.toISOString(), expiresAt: new Date(+now + 30000).toISOString(), status: 'unavailable', limitations: [], targets: [] };
  let finishClaim, claiming = false;
  const created = { id: 'paired-during-background', sourceDeviceId: sourceDevice.id, targetId: 'paired-tv', method: 'tv-receiver', view: { kind: 'ambient' }, state: 'starting', expiresAt: new Date(+now + 60000).toISOString() };
  window.ReactNativeWebView = { postMessage: raw => {
    const { command } = JSON.parse(raw);
    window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: command.requestId, ok: true, ...(command.action === 'discover' ? { inventory } : { state: 'stopped', sessionId: null }) } }));
  } };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method });
    if (url.endsWith('/claim')) { claiming = true; await new Promise(resolve => { finishClaim = resolve; }); return Response.json({ session: created }); }
    if (url.endsWith('/sessions') && claiming) throw new Error('Connection lost after claim');
    return Response.json(url.endsWith('/config') ? { receiverOrigin: 'https://receiver.example' } : url.endsWith('/sessions') ? { sessions: [] } : {});
  };
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(TravelPresentationLauncher)));
    await act(async () => div.querySelector('button').click());
    await act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(claiming, true);
    await act(async () => { window.dispatchEvent(new window.CustomEvent('nexus:display-background')); finishClaim(); });
    assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith('/paired-during-background')));
  } finally { await act(async () => root.unmount()); div.remove(); globalThis.fetch = originalFetch; delete window.__NEXUS_DISPLAYS__; delete window.ReactNativeWebView; }
});


test('native discovery remains visible when publication fails, but presenting still requires server acceptance', async () => {
  const originalFetch = globalThis.fetch;
  window.__NEXUS_DISPLAYS__ = { version: 1, platform: 'android' };
  const now = new Date(), commands = [], requests = [];
  const sourceDevice = { id: 'phone-offline', name: 'Pixel 9 Pro', platform: 'android' };
  const inventory = { version: 1, sourceDevice, observedAt: now.toISOString(), expiresAt: new Date(+now + 30000).toISOString(), status: 'available',
    limitations: ['Google Cast is not configured for this build.'], targets: [{ id: 'display-2', name: 'Attached screen', sourceDeviceId: sourceDevice.id,
      method: 'android-presentation', availability: 'available', observedAt: now.toISOString(), capabilities: ['ambient'], limitations: [] }] };
  window.ReactNativeWebView = { postMessage: raw => {
    const { command } = JSON.parse(raw); commands.push(command.action);
    window.dispatchEvent(new window.CustomEvent('nexus:display-result', { detail: { requestId: command.requestId, ok: true, inventory } }));
  } };
  globalThis.fetch = async url => {
    requests.push(url);
    return Response.json({ error: 'The display service is unavailable.' }, { status: 503 });
  };
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(TravelPresentationLauncher)));
    await act(async () => div.querySelector('button').click());
    assert.ok(document.body.textContent.includes('Source: Pixel 9 Pro'));
    assert.ok(document.body.textContent.includes('Google Cast is not configured for this build.'));
    assert.equal(document.querySelector('[role="alert"]').textContent, 'The display service is unavailable.');
    await act(async () => document.querySelector('input[value="display-2"]').click());
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Present on selected display').click());
    assert.ok(!commands.includes('start'));
    assert.ok(requests.every(url => url.endsWith('/inventory')));
  } finally { await act(async () => root.unmount()); div.remove(); globalThis.fetch = originalFetch; delete window.__NEXUS_DISPLAYS__; delete window.ReactNativeWebView; }
});
