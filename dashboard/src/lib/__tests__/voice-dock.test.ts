import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error Test loader supplies the controllable navigation module.
import { setPathname } from 'next/navigation';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('one root dock mounts inside existing providers and the home page owns no voice instance', () => {
  const layout = readFileSync(new URL('../../app/layout.tsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../../app/page.tsx', import.meta.url), 'utf8');
  assert.equal((layout.match(/<GlobalVoiceDock\s*\/>/g) ?? []).length, 1);
  assert.match(layout, /<LiveBoardStateProvider>[\s\S]*<GlobalVoiceDock\s*\/>[\s\S]*<\/LiveBoardStateProvider>/);
  assert.doesNotMatch(home, /VoiceCommandBar/);
});
test('dock preserves the actual recording and controls on ordinary navigation, then releases them on login', async t => {
  const module = await import('../../components/global-voice-dock').catch(() => null); assert.ok(module, 'global dock exists');
  localStorage.clear(); setPathname('/'); let stopped = 0; let recordings = 0;
  t.mock.method(globalThis, 'fetch', async input => String(input).includes('board') ? Response.json([]) : Response.json({ available: true }));
  const original = globalThis.MediaRecorder;
  Object.assign(globalThis, { MediaRecorder: class { static isTypeSupported() { return true; } state = 'inactive'; mimeType = 'audio/webm'; onstop = null; ondataavailable = null; start() { recordings++; this.state = 'recording'; } stop() { this.state = 'inactive'; } } });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); Object.assign(globalThis, { MediaRecorder: original }); setPathname('/'); });
  await act(async () => { root.render(React.createElement(module.GlobalVoiceDock)); await tick(); });
  const dock = host.querySelector('[aria-label="Global voice controls"]'); assert.ok(dock); assert.match(dock.className, /fixed/);
  await act(async () => { (host.querySelector('[aria-label="Start conversation"]') as HTMLButtonElement).click(); await tick(); });
  const stop = host.querySelector('[aria-label="Stop recording"]'); assert.ok(stop);
  await act(async () => { setPathname('/task-board'); await tick(); });
  assert.equal(host.querySelector('[aria-label="Stop recording"]'), stop); assert.equal(stopped, 0); assert.equal(recordings, 1);
  await act(async () => { setPathname('/login'); await tick(); });
  assert.equal(host.childElementCount, 0); assert.equal(stopped, 1);
  await act(async () => { setPathname('/ops'); await tick(); });
  assert.ok(host.querySelector('[aria-label="Start conversation"]')); assert.equal(recordings, 1);
});
