import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceCommandBar } from '../../components/bridge/voice-command-bar';
import { speechOwner } from '../speech-ownership';
import { VoiceAlerts } from '../voice-alerts';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
class Recorder {
  static all: Recorder[] = []; static size = 2500;
  static isTypeSupported() { return true; } state = 'inactive'; mimeType = 'audio/webm';
  onstop: (() => void) | null = null; onerror: (() => void) | null = null; ondataavailable: ((e: { data: Blob }) => void) | null = null;
  constructor() { Recorder.all.push(this); } start() { this.state = 'recording'; }
  stop() { if (this.state !== 'recording') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'.repeat(Recorder.size)]) }); this.onstop?.(); }
}
class Reader { result = 'data:audio/webm;base64,recorded'; onload: (() => void) | null = null; readAsDataURL() { this.onload?.(); } }
class AudioFake {
  static all: AudioFake[] = []; static blocked = false;
  onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
  paused = true; ended = false; src: string; constructor(src: string) { this.src = src; AudioFake.all.push(this); }
  play() { this.paused = false; return AudioFake.blocked ? Promise.reject(new Error('blocked')) : Promise.resolve(); }
  pause() { this.paused = true; this.onpause?.(); } load() {} removeAttribute() {}
}
type Options = { fetch?: (url: string, init: RequestInit | undefined) => Promise<Response | undefined>; analyser?: 'speech' | 'silence' | 'broken'; synth?: boolean; chunks?: number; wake?: boolean; };
async function mount(t: TestContext, options: Options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  localStorage.clear(); localStorage.setItem('nexus.voice.alertMode', 'off');
  if (options.wake) localStorage.setItem('nexus.voice.wakeword', '1');
  Recorder.all = []; Recorder.size = 2500; AudioFake.all = []; AudioFake.blocked = false;
  let captures = 0; let stopped = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { captures++; return { getTracks: () => [{ stop: () => stopped++ }] }; } } });
  const originalContext = window.AudioContext;
  if (options.analyser) Object.assign(window, { AudioContext: class {
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buf: Float32Array) { if (options.analyser === 'broken') throw new Error('analyser failed'); buf.fill(options.analyser === 'speech' ? 0.1 : 0); } }; }
    close() { return Promise.resolve(); }
  } });
  const requests: { url: string; signal?: AbortSignal | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const url = String(input); requests.push({ url, signal: init?.signal });
    const override = await options.fetch?.(url, init); if (override) return override;
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'chat' } });
    if (url.includes('transcribe')) return Response.json({ text: 'Tell me about the work today' });
    if (url.endsWith('/chat')) return Response.json({ response: 'A full reply.', ...(!options.synth ? { voiceData: Array.from({ length: options.chunks ?? 1 }, (_, i) => ({ audio: `reply-${i}`, mimeType: 'audio/wav' })) } : {}) });
    if (url.endsWith('/speak')) return Response.json({ audio: 'synthetic' });
    if (url.includes('board')) return Response.json([]);
    return Response.json({ available: true });
  });
  const originals = { MediaRecorder: globalThis.MediaRecorder, FileReader: globalThis.FileReader, Audio: globalThis.Audio };
  Object.assign(globalThis, { MediaRecorder: Recorder, FileReader: Reader, Audio: AudioFake });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(VoiceCommandBar)); await tick(); });
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); host.remove(); Object.assign(globalThis, originals); Object.assign(window, { AudioContext: originalContext }); });
  const click = async (label: string) => { const button = host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement; assert.ok(button, label); await act(async () => { button.click(); await tick(); }); };
  const advance = async (ms = 1000) => { await act(async () => { t.mock.timers.tick(ms); await tick(); }); };
  const endAudio = async () => { await act(async () => { const audio = AudioFake.all.at(-1); if (audio) { audio.paused = true; audio.ended = true; audio.onpause?.(); await tick(); audio.onended?.(); } await tick(); }); };
  const assertEnded = () => { assert.ok(host.querySelector('[aria-label="Start conversation"]')); assert.equal(host.querySelector('[aria-label="End conversation"]'), null); };
  return { host, click, advance, endAudio, assertEnded, requests, unmount, captures: () => captures, stopped: () => stopped };
}
test('conversation is off on mount; two turns chain only after every reply audio has ended', async t => {
  const f = await mount(t, { chunks: 2 }); f.assertEnded(); assert.equal(f.captures(), 0);
  await f.click('Start conversation'); await f.click('Stop recording');
  assert.equal(f.captures(), 1); await f.endAudio(); await f.advance(); assert.equal(f.captures(), 1);
  await f.endAudio(); assert.equal(f.captures(), 1); assert.equal(speechOwner.busy(), true);
  await f.advance(); assert.equal(f.captures(), 2);
  await f.click('Stop recording'); await f.endAudio(); await f.endAudio(); await f.advance();
  assert.equal(f.captures(), 3); await f.click('End conversation'); f.assertEnded();
});
test('ordinary push-to-talk and unrelated explicit playback never arm follow-up capture', async t => {
  const f = await mount(t); await f.click('Start voice command'); await f.click('Stop recording'); await f.endAudio(); await f.advance();
  assert.equal(f.captures(), 1); f.assertEnded(); const lease = speechOwner.claim('chat', () => {}); lease?.release(); await f.advance(); assert.equal(f.captures(), 1);
});
for (const stage of ['recording', 'speaking', 'settling'] as const) test(`End during ${stage} cancels resources and never reopens capture`, async t => {
  const f = await mount(t); await f.click('Start conversation');
  if (stage !== 'recording') await f.click('Stop recording');
  if (stage === 'settling') await f.endAudio();
  const staleEnd = AudioFake.all.at(-1)?.onended;
  await f.click('End conversation'); await act(async () => { staleEnd?.(); await tick(); }); await f.advance(61000);
  f.assertEnded(); assert.equal(f.captures(), 1); assert.equal(f.stopped(), 1); assert.equal(speechOwner.busy(), false);
});
for (const stage of ['synthesis', 'synthesis-json', 'transcription-json', 'chat-json']) test(`End invalidates deferred ${stage} even after a fresh conversation starts`, async t => {
  const pending = deferred<any>(); let used = false;
  const target = stage.startsWith('synthesis') ? '/speak' : stage.startsWith('transcription') ? '/transcribe' : '/chat';
  const f = await mount(t, { synth: true, fetch: async url => {
    if (!used && url.endsWith(target)) { used = true; return stage === 'synthesis' ? pending.promise : { ok: true, json: () => pending.promise } as Response; }
  } });
  await f.click('Start conversation'); await f.click('Stop recording');
  const request = f.requests.find(r => r.url.endsWith(target)); assert.ok(request);
  await f.click('End conversation'); assert.equal(request.signal?.aborted, true); await f.click('Start conversation');
  await act(async () => { pending.resolve(stage === 'synthesis' ? Response.json({ audio: 'stale' }) : { audio: 'stale', text: 'stale', response: 'stale' }); await tick(); });
  await f.advance(1000); assert.equal(f.captures(), 2); assert.equal(AudioFake.all.length, 0); assert.equal(Recorder.all.at(-1)?.state, 'recording');
});
test('End during deferred microphone permission releases its late stream', async t => {
  const f = await mount(t); const pending = deferred<any>(); let stopped = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => pending.promise } });
  await f.click('Start conversation'); await f.click('End conversation');
  await act(async () => { pending.resolve({ getTracks: () => [{ stop: () => stopped++ }] }); await tick(); }); await f.advance(61000);
  assert.equal(stopped, 1); assert.equal(Recorder.all.length, 0); f.assertEnded();
});
for (const analyser of [undefined, 'silence', 'broken'] as const) test(`ten-second no-speech end works with ${analyser ?? 'no'} analyser`, async t => {
  const f = await mount(t, { analyser }); await f.click('Start conversation'); await f.advance(10500);
  f.assertEnded(); assert.equal(f.stopped(), 1); assert.equal(f.requests.some(r => r.url.endsWith('/transcribe')), false);
  await f.advance(61000); assert.equal(f.captures(), 1);
});
for (const failure of ['permission', 'empty-blob', 'empty-transcript', 'transcription', 'chat', 'empty-reply', 'synthesis', 'playback', 'blocked-playback', 'recorder']) test(`${failure} failure ends conversation without reopening the mic`, async t => {
  const f = await mount(t, { synth: failure === 'synthesis', fetch: async url => {
    if (failure === 'empty-transcript' && url.endsWith('/transcribe')) return Response.json({ text: '' });
    if (failure === 'empty-reply' && url.endsWith('/chat')) return Response.json({ response: '   ' });
    if ((failure === 'transcription' && url.endsWith('/transcribe')) || (failure === 'chat' && url.endsWith('/chat')) || (failure === 'synthesis' && url.endsWith('/speak'))) return new Response('', { status: 500 });
  } });
  if (failure === 'permission') Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new Error('denied'); } } });
  if (failure === 'empty-blob') Recorder.size = 0;
  if (failure === 'blocked-playback') AudioFake.blocked = true;
  await f.click('Start conversation');
  if (failure === 'recorder') await act(async () => { Recorder.all.at(-1)?.onerror?.(); await tick(); });
  else if (failure !== 'permission') await f.click('Stop recording');
  if (failure === 'playback') await act(async () => { AudioFake.all.at(-1)?.onerror?.(); await tick(); });
  f.assertEnded(); await f.advance(61000); assert.ok(f.captures() <= 1); assert.equal(speechOwner.busy(), false);
});
for (const stage of ['recording', 'speaking', 'settling'] as const) test(`external explicit player preempts ${stage} and retains ownership past follow-up delay`, async t => {
  const f = await mount(t); await f.click('Start conversation'); if (stage !== 'recording') await f.click('Stop recording'); if (stage === 'settling') await f.endAudio();
  let canceled = false; let lease: ReturnType<typeof speechOwner.claim>;
  await act(async () => { lease = speechOwner.claim('chat', () => canceled = true); await tick(); });
  t.after(() => lease?.release()); await f.advance(2000); f.assertEnded(); assert.equal(f.captures(), 1); assert.equal(canceled, false); assert.equal(lease!.owns(), true);
});
for (const event of ['Escape', 'hidden'] as const) test(`${event} ends active capture and clears follow-up work`, async t => {
  const f = await mount(t); await f.click('Start conversation');
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  await act(async () => {
    if (event === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new window.Event('visibilitychange')); }
    await tick();
  });
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden); else delete (document as any).hidden;
  f.assertEnded(); await f.advance(61000); assert.equal(f.captures(), 1); assert.equal(f.stopped(), 1);
});
test('alerts wait throughout a conversation turn and settling gap, then never arm capture', async t => {
  const f = await mount(t); await f.click('Start conversation');
  let announcements = 0; const now = new Date(2026, 8, 7, 12).getTime();
  const alerts = new VoiceAlerts({ mountedAt: now - 1000, now: () => now, active: async () => true, announce: async () => { announcements++; } });
  t.after(() => alerts.dispose()); alerts.update([{ eventId: 'owned-turn', at: new Date(now).toISOString(), type: 'task.completed', taskId: 'one' } as any], 'conversational');
  await f.click('Stop recording'); await f.endAudio(); await f.advance(200); assert.equal(announcements, 0); assert.equal(f.captures(), 1);
  await f.click('End conversation'); await f.advance(5000); assert.equal(announcements, 1); assert.equal(f.captures(), 1); f.assertEnded();
});

test('conversation suspends an enabled wake recognizer through End and reports that it is paused', async t => {
  let starts = 0; let live = 0;
  const original = (window as any).webkitSpeechRecognition;
  Object.assign(window, { webkitSpeechRecognition: class {
    onend: (() => void) | null = null; running = false;
    start() { if (!this.running) { this.running = true; starts++; live++; } }
    abort() { if (this.running) { this.running = false; live--; this.onend?.(); } }
  } });
  t.after(() => Object.assign(window, { webkitSpeechRecognition: original }));
  const f = await mount(t, { wake: true }); assert.equal(live, 1);
  await f.click('Start conversation'); assert.equal(live, 0); const startsBefore = starts;
  await f.click('Stop recording'); await f.endAudio(); await f.advance(); assert.equal(starts, startsBefore); assert.equal(live, 0);
  await f.click('End conversation'); await f.advance(); assert.equal(starts, startsBefore);
  assert.doesNotMatch(f.host.querySelector('[aria-label="Start voice command"]')?.getAttribute('title') ?? '', /Listening/);
});
test('opening a capture from settings leaves one upward panel visible', async t => {
  const f = await mount(t); await f.click('Voice settings'); await f.click('Start conversation'); await f.click('Stop recording');
  assert.doesNotMatch(f.host.textContent ?? '', /voice and ambient/); assert.match(f.host.textContent ?? '', /voice channel/);
});
for (const analyser of [undefined, 'broken'] as const) test(`manual push-to-talk keeps its stop control beyond ten seconds with ${analyser ?? 'no'} analyser`, async t => {
  const f = await mount(t, { analyser }); await f.click('Start voice command'); await f.advance(10500);
  assert.equal(Recorder.all.at(-1)?.state, 'recording'); assert.equal(f.stopped(), 0);
  assert.doesNotMatch(f.host.textContent ?? '', /didn't hear anything/);
  await f.click('Stop recording'); assert.equal(f.requests.filter(r => r.url.endsWith('/transcribe')).length, 1);
  await f.endAudio(); await f.advance(); assert.equal(f.captures(), 1); f.assertEnded();
});
