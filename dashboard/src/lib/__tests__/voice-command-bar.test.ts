import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceCommandBar } from '../../components/bridge/voice-command-bar';
const tick = () => new Promise(resolve => setImmediate(resolve));
class Recorder {
  static isTypeSupported() { return true; } state = 'inactive'; mimeType = 'audio/webm';
  static latest: Recorder;
  onstop: (() => void) | null = null; ondataavailable: ((e: { data: Blob }) => void) | null = null;
  constructor() { Recorder.latest = this; }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(2500)]) }); this.onstop?.(); }
}
class Reader { result = 'data:audio/webm;base64,recorded'; onload: (() => void) | null = null; readAsDataURL() { this.onload?.(); } }
class FakeAudio {
  static all: FakeAudio[] = []; onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
  paused = true; src: string; constructor(src: string) { this.src = src; FakeAudio.all.push(this); }
  play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; this.onpause?.(); } load() {} removeAttribute() {}
}
async function mount(t: Parameters<Parameters<typeof test>[1]>[0], deferredSpeak = false) {
  localStorage.clear(); FakeAudio.all = []; let tracksStopped = 0; const requests: { url: string; body: any; signal?: AbortSignal }[] = [];
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped++ }] }) } });
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = String(input); const body = init?.body ? JSON.parse(init.body) : null; requests.push({ url, body, signal: init?.signal });
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'chat' } });
    if (url.includes('transcribe')) return Response.json({ text: 'Tell me about the work today' });
    if (url.endsWith('/chat')) return Response.json({ response: 'A full reply.', ...(deferredSpeak ? {} : { voiceData: [{ audio: 'provided', mimeType: 'audio/wav' }] }) });
    if (url.endsWith('/speak')) return deferredSpeak ? new Promise<Response>(() => {}) : Response.json({ audio: 'synthetic' });
    if (url.includes('board')) return Response.json([]);
    return Response.json({ available: true });
  });
  const originals = { MediaRecorder: globalThis.MediaRecorder, FileReader: globalThis.FileReader, Audio: globalThis.Audio };
  Object.assign(globalThis, { MediaRecorder: Recorder, FileReader: Reader, Audio: FakeAudio });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(VoiceCommandBar)); await tick(); });
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); host.remove(); Object.assign(globalThis, originals); });
  const click = async (label: string) => { const button = host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement; assert.ok(button, label); await act(async () => { button.click(); await tick(); }); };
  return { host, click, requests, unmount, tracksStopped: () => tracksStopped };
}
test('voice chat identifies spoken conversation and uses provided audio without resynthesis', async t => {
  const f = await mount(t); await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(f.requests.find(r => r.url.endsWith('/chat'))?.body.voiceConversation, true);
  assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false); assert.match(FakeAudio.all[0].src, /provided/);
});
test('pending synthesis can be stopped before any audio exists', async t => {
  const f = await mount(t, true); await f.click('Start voice command'); await f.click('Stop recording');
  const pending = f.requests.find(r => r.url.endsWith('/speak')); assert.ok(pending);
  await f.click('Stop speaking'); assert.equal(pending.signal?.aborted, true);
});
test('recording shows elapsed seconds and allows speech beyond fifteen seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  // Simulate a microphone with speech so the initial no-speech deadline is cleared.
  const original = window.AudioContext;
  Object.assign(window, { AudioContext: class { createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buf: Float32Array) { buf.fill(0.1); } }; } close() { return Promise.resolve(); } } });
  t.after(() => Object.assign(window, { AudioContext: original }));
  const f = await mount(t); await f.click('Start voice command');
  await act(async () => { t.mock.timers.tick(16000); await tick(); });
  assert.equal(Recorder.latest.state, 'recording'); assert.match(f.host.textContent ?? '', /16s/);
  await act(async () => { t.mock.timers.tick(44000); await tick(); }); assert.equal(Recorder.latest.state, 'inactive');
});
test('initial silence releases capture without transcribing', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const original = window.AudioContext;
  Object.assign(window, { AudioContext: class { createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buf: Float32Array) { buf.fill(0); } }; } close() { return Promise.resolve(); } } });
  t.after(() => Object.assign(window, { AudioContext: original }));
  const f = await mount(t); await f.click('Start voice command');
  await act(async () => { t.mock.timers.tick(10500); await tick(); });
  assert.equal(Recorder.latest.state, 'inactive'); assert.equal(f.tracksStopped(), 1);
  assert.equal(f.requests.some(r => r.url.includes('transcribe')), false); assert.match(f.host.textContent ?? '', /didn't hear anything/);
});
test('cancel while waiting for microphone permission releases a late stream', async t => {
  const f = await mount(t); let finish!: (stream: any) => void; let stopped = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise(resolve => finish = resolve) } });
  await f.click('Start voice command'); await f.click('Cancel voice command');
  await act(async () => { finish({ getTracks: () => [{ stop: () => stopped++ }] }); await tick(); });
  assert.equal(stopped, 1); assert.equal(f.requests.some(r => r.url.includes('transcribe')), false);
});
test('unmount stops microphone tracks and cancels recording timers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = await mount(t); await f.click('Start voice command'); await f.unmount();
  assert.equal(f.tracksStopped(), 1); assert.equal(Recorder.latest.state, 'inactive');
  await act(async () => { t.mock.timers.tick(61000); await tick(); }); assert.equal(f.requests.some(r => r.url.includes('transcribe')), false);
});
test('unmount aborts a pending speech request', async t => {
  const f = await mount(t, true); await f.click('Start voice command'); await f.click('Stop recording');
  const pending = f.requests.find(r => r.url.endsWith('/speak')); await f.unmount(); assert.equal(pending?.signal?.aborted, true);
});
