import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { setParams, setPathname } from '../../../test/stubs/next-navigation.mjs';
import { cortexTestStore } from '../../../test/stubs/cortex-provider.mjs';
import { LiveBoardStateProvider } from '../../components/live-board-state';
import { __sockets } from '../../../test/stubs/socket-io-client.mjs';
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
async function mount(t: Parameters<Parameters<typeof test>[1]>[0], deferredSpeak = false, override?: (url: string, body: any, signal?: AbortSignal) => Promise<Response | undefined>, withLiveBoard = false) {
  setParams({}); setPathname('/');
  cortexTestStore.reset([{ id: "typed-context", role: "user", content: "Earlier typed context", timestamp: new Date() }]);
  localStorage.clear(); FakeAudio.all = []; let tracksStopped = 0; const requests: { url: string; body: any; signal?: AbortSignal }[] = [];
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped++ }] }) } });
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = String(input); const body = init?.body ? JSON.parse(init.body) : null; requests.push({ url, body, signal: init?.signal });
    const replacement = await override?.(url, body, init?.signal); if (replacement) return replacement;
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'chat' } });
    if (url.endsWith('/voice-prose')) return Response.json({ text: `Fresh spoken response ${requests.filter(r => r.url.endsWith('/voice-prose')).length}.` });
    if (url.includes('transcribe')) return Response.json({ text: 'Tell me about the work today' });
    if (url.endsWith('/chat')) return Response.json({ accepted: true, status: 'completed', clientMessageId: body.clientMessageId, conversationId: body.conversationId, assistantMessageId: `${body.clientMessageId}:reply`, messages: [{ id: body.clientMessageId, conversation_id: body.conversationId, role: 'user', content: body.message }, { id: `${body.clientMessageId}:reply`, conversation_id: body.conversationId, role: 'assistant', content: 'A full reply.', metadata: { playbackOwner: 'voice' } }], response: 'A full reply.', ...(deferredSpeak ? {} : { voiceData: [{ audio: 'provided', mimeType: 'audio/wav' }] }) });
    if (url.endsWith('/sync')) return Response.json({ ok: true, synced: body.messages.length, messages: body.messages.map((m: any) => ({ ...m, conversation_id: body.conversationId })) });
    if (url.endsWith('/speak')) return deferredSpeak ? new Promise<Response>(() => {}) : Response.json({ audio: 'synthetic' });
    if (url.includes('board')) return Response.json([]);
    return Response.json({ available: true });
  });
  const originals = { MediaRecorder: globalThis.MediaRecorder, FileReader: globalThis.FileReader, Audio: globalThis.Audio };
  Object.assign(globalThis, { MediaRecorder: Recorder, FileReader: Reader, Audio: FakeAudio });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(withLiveBoard ? React.createElement(LiveBoardStateProvider, null, React.createElement(VoiceCommandBar)) : React.createElement(VoiceCommandBar)); await tick(); });
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  t.after(async () => { await unmount(); host.remove(); Object.assign(globalThis, originals); });
  const click = async (label: string) => { const button = host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement; assert.ok(button, label); await act(async () => { button.click(); await tick(); }); };
  return { host, click, requests, unmount, tracksStopped: () => tracksStopped };
}
test('voice chat identifies spoken conversation and uses provided audio without resynthesis', async t => {
  const f = await mount(t); await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(f.requests.find(r => r.url.endsWith('/chat'))?.body.voiceConversation, true);
  assert.equal(f.requests.some(r => r.url.endsWith('/speak') || r.url.endsWith('/voice-prose')), false); assert.match(FakeAudio.all[0].src, /provided/);
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

test('voice shares typed history and merges saved receipt rows once without socket delivery', async t => {
  const f = await mount(t); await f.click('Start voice command'); await f.click('Stop recording');
  const request = f.requests.find(r => r.url === '/api/ai/chat'); assert.ok(request);
  assert.equal(request.body.async, true); assert.equal(request.body.conversationId, 'test-conversation');
  assert.deepEqual(request.body.history, [{ role: 'user', content: 'Earlier typed context' }]);
  assert.equal(cortexTestStore.messages.length, 3); assert.equal(cortexTestStore.messages[2].id, `${request.body.clientMessageId}:reply`);
  assert.equal(FakeAudio.all.length, 1);
});
test('a selection change during classification keeps the original chat and does not merge into the new one', async t => {
  let finish!: (response: Response) => void;
  const f = await mount(t, false, async url => url.includes('voice-intent') ? new Promise(resolve => finish = resolve) : undefined);
  await f.click('Start voice command'); await f.click('Stop recording');
  await act(async () => { cortexTestStore.setConversation('different'); finish(Response.json({ intent: { type: 'chat' } })); await tick(); });
  assert.equal(f.requests.find(r => r.url === '/api/ai/chat')?.body.conversationId, 'test-conversation');
  assert.equal(cortexTestStore.messages.length, 0);
});
test('local navigation archives the transcript and result using stable IDs in shared chat', async t => {
  const f = await mount(t, false, async url => url.includes('voice-intent') ? Response.json({ intent: { type: 'navigate', route: '/task-board', label: 'Task board', speech: 'On screen. Task board.' } }) : undefined);
  await f.click('Start voice command'); await f.click('Stop recording');
  const saves = f.requests.filter(r => r.url.endsWith('/sync')); assert.equal(saves.length, 2);
  assert.equal(saves[0].body.messages.length, 1); assert.equal(saves[1].body.messages[0].id, saves[0].body.messages[0].id);
  assert.equal(saves[1].body.messages[1].metadata.playbackOwner, 'voice');
  assert.equal(cortexTestStore.messages.length, 3); assert.ok(f.host.textContent?.includes('Fresh spoken response 1.'));
  assert.equal(saves[1].body.messages[1].content, 'Fresh spoken response 1.');
  assert.equal(f.requests.find(r => r.url.endsWith('/speak'))?.body.text, 'Fresh spoken response 1.');
  assert.equal(f.requests.some(r => r.url === '/api/ai/chat'), false);
});
test('ending during a local queue request retains the transcript and records its uncertain outcome', async t => {
  let queueSignal!: AbortSignal;
  const f = await mount(t, false, async (url, _body, signal) => {
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'local_queue', action: 'pause', speech: 'Queue paused.' } });
    if (url === '/api/local-queue/pause') { queueSignal = signal!; return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); }
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(cortexTestStore.messages.length, 2);
  await f.click('Cancel voice command'); assert.equal(queueSignal.aborted, true);
  assert.equal(cortexTestStore.messages.length, 3); assert.match(cortexTestStore.messages[2].content, /uncertain/i);
  assert.equal(FakeAudio.all.length, 0);
});
test('archival failure reports the successful local action separately and never reruns it', async t => {
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'local_queue', action: 'pause', speech: 'Queue paused.' } });
    if (url.endsWith('/sync')) return Response.json({ error: 'Chat unavailable' }, { status: 400 });
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(f.requests.filter(r => r.url === '/api/local-queue/pause').length, 1);
  assert.match(f.host.textContent ?? '', /Fresh spoken response/); assert.match(f.host.textContent ?? '', /could not be saved/i);
});
test('voice waits for a selected shared chat before opening the microphone', async t => {
  const f = await mount(t);
  await act(async () => { cortexTestStore.setConversation(null); await tick(); });
  await f.click('Start voice command');
  assert.match(f.host.textContent ?? '', /shared chat.*loading/i);
  assert.equal(f.host.querySelector('[aria-label="Stop recording"]'), null);
  assert.equal(f.requests.some(r => r.url.includes('transcribe')), false);
});
test('changing chat while recording keeps the conversation where the voice turn began', async t => {
  const f = await mount(t); await f.click('Start voice command');
  await act(async () => { cortexTestStore.setConversation('different'); await tick(); });
  await f.click('Stop recording');
  assert.equal(f.requests.find(r => r.url === '/api/ai/chat')?.body.conversationId, 'test-conversation');
  assert.equal(cortexTestStore.messages.length, 0);
});

for (const pathname of ['/task/task-42', '/studio/idea/idea-42']) test(`voice on ${pathname} omits unrelated route IDs from project scope`, async t => {
  const f = await mount(t);
  await act(async () => { setPathname(pathname); setParams({ id: pathname.split('/').at(-1) }); await tick(); });
  await f.click('Start voice command'); await f.click('Stop recording');
  const request = f.requests.find(r => r.url === '/api/ai/chat'); assert.ok(request);
  assert.equal(Object.hasOwn(request.body, 'projectId'), false);
});
test('voice captures the canonical project scope before later route navigation', async t => {
  const f = await mount(t);
  await act(async () => { setPathname('/project/project-42'); setParams({ id: 'project-42' }); await tick(); });
  await f.click('Start voice command');
  await act(async () => { setPathname('/task/task-42'); setParams({ id: 'task-42' }); await tick(); });
  await f.click('Stop recording');
  assert.equal(f.requests.find(r => r.url === '/api/ai/chat')?.body.projectId, 'project-42');
});

const queueIntent = { type: 'local_queue', action: 'pause', speech: 'DO NOT SPEAK STOCK TEXT' };
test('writer failure keeps the completed action factual and silent without rerunning it', async t => {
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: queueIntent });
    if (url.endsWith('/voice-prose')) return Response.json({ error: 'unavailable' }, { status: 503 });
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(f.requests.filter(r => r.url === '/api/local-queue/pause').length, 1);
  assert.equal(f.requests.filter(r => r.url.endsWith('/voice-prose')).length, 1);
  assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false); assert.equal(FakeAudio.all.length, 0);
  assert.match(f.host.textContent ?? '', /queue paused/i); assert.match(f.host.textContent ?? '', /text.only/i);
  assert.match(cortexTestStore.messages.at(-1)!.content, /queue paused/i);
});
test('ending during composition aborts the writer and archives the known action with no late speech', async t => {
  let finish!: (response: Response) => void;
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: queueIntent });
    if (url.endsWith('/voice-prose')) return new Promise(resolve => finish = resolve);
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  const composing = f.requests.find(r => r.url.endsWith('/voice-prose')); assert.ok(composing);
  await f.click('Cancel voice command'); assert.equal(composing.signal?.aborted, true);
  await act(async () => { finish(Response.json({ text: 'Too late to speak.' })); await tick(); });
  assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false);
  assert.equal(f.requests.filter(r => r.url === '/api/local-queue/pause').length, 1);
  assert.match(cortexTestStore.messages.at(-1)!.content, /queue paused/i);
});
for (const intent of [
  { type: 'status_report', speechContext: { kind: 'command-result', facts: { presence: { activity: 'working' }, report: { started: true, inFlight: true, outcome: 'started' } } } },
  { type: 'demo_mode', enable: true, speechContext: { kind: 'demo-mode', facts: { active: true, changed: true } } },
  { type: 'away_briefing', speechContext: { kind: 'away-briefing', facts: { report: { started: true, inFlight: true, outcome: 'started' }, requestedDelivery: ['phone', 'email'] } } },
]) {
  test(`${intent.type} composes known server facts once without executing another action`, async t => {
    const f = await mount(t, false, async url => url.includes('voice-intent') ? Response.json({ intent }) : undefined);
    await f.click('Start voice command'); await f.click('Stop recording');
    assert.deepEqual(f.requests.find(r => r.url.endsWith('/voice-prose'))?.body, intent.speechContext);
    assert.equal(f.requests.filter(r => r.url.includes('voice-intent')).length, 1);
    assert.equal(f.requests.some(r => /status-report|demo-mode|away-briefing/.test(r.url)), false);
    assert.equal(cortexTestStore.messages.at(-1)!.content, 'Fresh spoken response 1.');
  });
  test(`End during transcript archival preserves already executed ${intent.type}`, async t => {
    let finish!: (response: Response) => void; let firstBody: any;
    const f = await mount(t, false, async (url, body) => {
      if (url.includes('voice-intent')) return Response.json({ intent });
      if (url.endsWith('/sync') && body.messages.length === 1) { firstBody = body; return new Promise(resolve => finish = resolve); }
    });
    await f.click('Start voice command'); await f.click('Stop recording'); await f.click('Cancel voice command');
    await act(async () => { finish(Response.json({ ok: true, synced: 1, messages: firstBody.messages.map((m: any) => ({ ...m, conversation_id: firstBody.conversationId })) })); await tick(); });
    assert.equal(f.requests.some(r => r.url.endsWith('/speak') || r.url.endsWith('/voice-prose')), false);
    assert.match(cortexTestStore.messages.at(-1)!.content, intent.type === 'demo_mode' ? /demo mode.*active/i : /report.*started/i);
    assert.doesNotMatch(cortexTestStore.messages.at(-1)!.content, /before.*executed|sent|delivered/i);
  });
}
test('cancellation while classification is unresolved archives uncertainty about server actions', async t => {
  const f = await mount(t, false, async url => url.includes('voice-intent') ? new Promise(() => {}) : undefined);
  await f.click('Start voice command'); await f.click('Stop recording'); await f.click('Cancel voice command');
  assert.match(cortexTestStore.messages.at(-1)!.content, /uncertain/i);
  assert.doesNotMatch(cortexTestStore.messages.at(-1)!.content, /before.*executed/i);
});
test('a suppressed chat receipt is displayed unchanged with no generation or playback', async t => {
  const f = await mount(t, false, async (url, body) => url === '/api/ai/chat' ? Response.json({ accepted: true, status: 'completed', clientMessageId: body.clientMessageId, conversationId: body.conversationId, response: 'Report started. Speech unavailable.', suppressVoice: true, voiceData: [{ audio: 'must-not-play' }] }) : undefined);
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.match(f.host.textContent ?? '', /Report started. Speech unavailable./);
  assert.equal(FakeAudio.all.length, 0); assert.equal(f.requests.some(r => /voice-prose|\/speak$/.test(r.url)), false);
});
test('every voice test writes fresh audibility prose and displays the exact synthesized words', async t => {
  const f = await mount(t); await f.click('Voice settings');
  await f.click('Test Praxis voice'); await f.click('Test Praxis voice');
  const scripts = f.requests.filter(r => r.url.endsWith('/voice-prose'));
  assert.equal(scripts.length, 2); assert.equal(scripts[0].body.kind, 'voice-test');
  assert.deepEqual(scripts[0].body.facts, { purpose: 'Check voice audibility' });
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/speak')).map(r => r.body.text), ['Fresh spoken response 1.', 'Fresh spoken response 2.']);
  assert.match(f.host.textContent ?? '', /Fresh spoken response 2./);
});

for (const phase of ['headers', 'body']) test(`stalled writer ${phase} times out without speech or another command`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: queueIntent });
    if (url.endsWith('/voice-prose')) return phase === 'headers' ? new Promise(() => {}) : { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  await act(async () => { t.mock.timers.tick(35000); await tick(); });
  assert.equal(f.requests.find(r => r.url.endsWith('/voice-prose'))?.signal?.aborted, true);
  assert.equal(f.requests.filter(r => r.url === '/api/local-queue/pause').length, 1);
  assert.equal(FakeAudio.all.length, 0); assert.match(f.host.textContent ?? '', /text.only/i);
  assert.match(cortexTestStore.messages.at(-1)!.content, /queue paused/i);
});
for (const cancel of ['hidden', 'unmount']) test(`${cancel} cancels a pending voice test without late speech`, async t => {
  let finish!: (response: Response) => void;
  const f = await mount(t, false, async url => url.endsWith('/voice-prose') ? new Promise(resolve => finish = resolve) : undefined);
  await f.click('Voice settings'); await f.click('Test Praxis voice');
  if (cancel === 'unmount') await f.unmount();
  else {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    t.after(() => { delete (document as any).hidden; });
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); await tick(); });
  }
  await act(async () => { finish(Response.json({ text: 'Late words.' })); await tick(); });
  assert.equal(f.requests.find(r => r.url.endsWith('/voice-prose'))?.signal?.aborted, true);
  assert.equal(FakeAudio.all.length, 0); assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false);
});
test('voice test writer failure stays text only', async t => {
  const f = await mount(t, false, async url => url.endsWith('/voice-prose') ? Response.json({ error: 'offline' }, { status: 503 }) : undefined);
  await f.click('Voice settings'); await f.click('Test Praxis voice');
  assert.equal(FakeAudio.all.length, 0); assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false);
  assert.match(f.host.textContent ?? '', /text.only.*unavailable/i);
});
test('two eligible live alerts each compose once and replayed event IDs stay deduplicated', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 8, 12).getTime() });
  t.mock.method(document, 'hasFocus', () => true);
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => Object.assign(globalThis, { EventSource: originalEventSource }));
  const f = await mount(t, false, undefined, true);
  const socket = __sockets.at(-1);
  const first = { type: 'task.failed', eventId: 'fresh-alert-first', taskId: 'task-1', error: 'Build failed', at: new Date(Date.now() + 1).toISOString() };
  await act(async () => { t.mock.timers.tick(1); socket.__emit('praxis:event', first); await tick(); await tick(); });
  assert.equal(f.requests.filter(r => r.url.endsWith('/voice-prose')).length, 1);
  assert.deepEqual(f.requests.find(r => r.url.endsWith('/voice-prose'))?.body, { kind: 'alert', facts: { taskId: 'task-1', status: 'failed', reason: 'Build failed' } });
  assert.doesNotMatch(f.host.textContent ?? '', /Fresh spoken response 1./);
  assert.equal(FakeAudio.all[0].src, '/audio/tng-combadge.mp3');
  assert.equal(FakeAudio.all.length, 1, 'speech waits for the combadge');
  await act(async () => { FakeAudio.all[0].onended?.(); await tick(); await tick(); });
  assert.equal(FakeAudio.all.length, 2); assert.match(FakeAudio.all[1].src, /synthetic/);
  await act(async () => { FakeAudio.all[1].onended?.(); await tick(); t.mock.timers.tick(120000); socket.__emit('praxis:event', first); socket.__emit('praxis:event', { ...first, type: 'task.completed', eventId: 'fresh-alert-second', at: new Date().toISOString() }); await tick(); await tick(); });
  assert.equal(f.requests.filter(r => r.url.endsWith('/voice-prose')).length, 2);
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/speak')).map(r => r.body.text), ['Fresh spoken response 1.', 'Fresh spoken response 2.']);
  assert.doesNotMatch(f.host.textContent ?? '', /Fresh spoken response 2./);
  await act(async () => { FakeAudio.all[2].onended?.(); await tick(); });
  assert.match(f.host.textContent ?? '', /Fresh spoken response 2./);
  assert.equal(FakeAudio.all[2].src, '/audio/tng-combadge.mp3');
  assert.equal(FakeAudio.all.filter(a => a.src === '/audio/tng-combadge.mp3').length, 2);
});

test('model control composes the confirmed returned state once', async t => {
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'local_only', enable: true, speech: 'stock' } });
    if (url === '/api/model-control/local-only') return Response.json({ enabled: true, reason: 'voice_command' });
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.equal(f.requests.filter(r => r.url === '/api/model-control/local-only').length, 1);
  assert.deepEqual(f.requests.find(r => r.url.endsWith('/voice-prose'))?.body.facts, { action: 'local_only', enabled: true, outcome: 'updated' });
});
test('malformed model control result never claims a successful enabled or disabled state', async t => {
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: { type: 'local_only', enable: true } });
    if (url.endsWith('/voice-prose')) return Response.json({ error: 'offline' }, { status: 503 });
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  assert.match(cortexTestStore.messages.at(-1)!.content, /uncertain/i);
  assert.equal(f.requests.find(r => r.url.endsWith('/voice-prose'))?.body.facts.outcome, 'uncertain');
  assert.equal(FakeAudio.all.length, 0);
});

test('switching chat during composition archives the spoken words only in the original conversation', async t => {
  let finish!: (response: Response) => void;
  const f = await mount(t, false, async url => {
    if (url.includes('voice-intent')) return Response.json({ intent: queueIntent });
    if (url.endsWith('/voice-prose')) return new Promise(resolve => finish = resolve);
  });
  await f.click('Start voice command'); await f.click('Stop recording');
  await act(async () => { cortexTestStore.setConversation('other-chat'); finish(Response.json({ text: 'Fresh result for the original chat.' })); await tick(); });
  const saved = f.requests.filter(r => r.url.endsWith('/sync')).at(-1)!;
  assert.equal(saved.body.conversationId, 'test-conversation');
  assert.equal(saved.body.messages[1].content, 'Fresh result for the original chat.');
  assert.equal(f.requests.find(r => r.url.endsWith('/speak'))?.body.text, saved.body.messages[1].content);
  assert.equal(cortexTestStore.messages.length, 0);
});

test('a hidden tab cannot begin composing a new alert even when it is still the active client', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 8, 12).getTime() });
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => { Object.assign(globalThis, { EventSource: originalEventSource }); delete (document as any).hidden; });
  const { getClientId } = await import('../active-client');
  const f = await mount(t, false, async url => url === '/api/presence/active-client' ? Response.json({ active: { clientId: getClientId() } }) : undefined, true);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => {
    document.dispatchEvent(new window.Event('visibilitychange')); t.mock.timers.tick(1);
    __sockets.at(-1).__emit('praxis:event', { type: 'task.failed', eventId: 'hidden-alert', taskId: 'task-1', error: 'Build failed', at: new Date().toISOString() });
    await tick(); await tick();
  });
  assert.equal(f.requests.some(r => r.url.endsWith('/voice-prose') || r.url.endsWith('/speak')), false);
});

for (const change of ['off', 'attention', 'quiet-hours', 'device']) test(`an alert cannot start playback when ${change} changes during prose composition`, async t => {
  const at = new Date(2026, 8, 8, change === 'quiet-hours' ? 21 : 12, change === 'quiet-hours' ? 59 : 0, change === 'quiet-hours' ? 59 : 0).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: at });
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => Object.assign(globalThis, { EventSource: originalEventSource }));
  const { getClientId } = await import('../active-client');
  let finish!: (response: Response) => void; let active = true;
  const f = await mount(t, false, async url => {
    if (url === '/api/presence/active-client') return Response.json({ active: { clientId: active ? getClientId() : 'another-device' } });
    if (url.endsWith('/voice-prose')) return new Promise(resolve => finish = resolve);
  }, true);
  await act(async () => {
    t.mock.timers.tick(1);
    __sockets.at(-1).__emit('praxis:event', { type: 'task.completed', eventId: `held-alert-${change}`, taskId: 'task-1', at: new Date().toISOString() });
    await tick(); await tick();
  });
  assert.equal(f.requests.filter(r => r.url.endsWith('/voice-prose')).length, 1);
  if (change === 'off' || change === 'attention') {
    await f.click('Voice settings');
    await act(async () => {
      const select = f.host.querySelector('[aria-label="Spoken alert mode"]') as HTMLSelectElement;
      select.value = change; select.dispatchEvent(new window.Event('change', { bubbles: true })); await tick();
    });
  }
  if (change === 'device') active = false;
  await act(async () => {
    if (change === 'quiet-hours') t.mock.timers.tick(2000);
    finish(Response.json({ text: 'The held announcement is ready.' })); await tick(); await tick();
  });
  assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false); assert.equal(FakeAudio.all.length, 0);
  assert.equal(f.requests.filter(r => r.url.endsWith('/voice-prose')).length, 1);
});

test('alert playback cancels a stalled active-device response body at its deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 8, 12).getTime() });
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => Object.assign(globalThis, { EventSource: originalEventSource }));
  const { getClientId } = await import('../active-client');
  let checks = 0; let playbackSignal: AbortSignal | undefined;
  const f = await mount(t, false, async (url, _body, signal) => {
    if (url !== '/api/presence/active-client') return;
    if (++checks === 1) return Response.json({ active: { clientId: getClientId() } });
    playbackSignal = signal;
    return { ok: true, json: () => new Promise(() => {}) } as Response;
  }, true);
  await act(async () => {
    t.mock.timers.tick(1);
    __sockets.at(-1).__emit('praxis:event', { type: 'task.completed', eventId: 'held-device-body', taskId: 'task-1', at: new Date().toISOString() });
    await tick(); await tick();
  });
  assert.equal(checks, 2);
  await act(async () => { t.mock.timers.tick(1500); await tick(); });
  assert.equal(playbackSignal?.aborted, true);
  assert.equal(f.requests.some(r => r.url.endsWith('/speak')), false);
  assert.ok(f.host.querySelector('[aria-label="Start voice command"]'));
});

test('a repeated announcement speaks its saved wording and does not copy another conversation into this chat', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 8, 12).getTime() });
  t.mock.method(document, 'hasFocus', () => true);
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => Object.assign(globalThis, { EventSource: originalEventSource }));
  const f = await mount(t, false, async (url, body) => {
    if (url.endsWith('/sync')) return Response.json({ ok: true, synced: 1, messages: [{ ...body.messages[0], conversation_id: 'original-conversation', content: 'The previously saved announcement.' }] });
  }, true);
  await act(async () => {
    t.mock.timers.tick(1);
    __sockets.at(-1).__emit('praxis:event', { type: 'task.failed', eventId: 'repeat-event', taskId: 'task-1', error: 'Build failed', at: new Date().toISOString() });
    await tick(); await tick();
  });
  assert.equal(f.requests.find(r => r.url.endsWith('/speak'))?.body.text, 'The previously saved announcement.');
  assert.doesNotMatch(f.host.textContent ?? '', /previously saved announcement/);
  await act(async () => { FakeAudio.all[0].onended?.(); await tick(); });
  assert.match(f.host.textContent ?? '', /previously saved announcement/);
  assert.equal(cortexTestStore.messages.some(m => m.id === 'voice-alert:repeat-event'), false);
  assert.equal(FakeAudio.all[0].src, '/audio/tng-combadge.mp3');
});

test('voice test preserves the specific speech failure instead of blaming volume', async t => {
  const f = await mount(t, false, async url => url.endsWith('/speak') ? Response.json({ error: 'busy' }, { status: 503 }) : undefined);
  await f.click('Voice settings'); await f.click('Test Praxis voice');
  assert.match(f.host.textContent ?? '', /HTTP 503/);
  assert.doesNotMatch(f.host.textContent ?? '', /Check the output volume/);
});

for (const mode of ['success', 'synthesis-failure', 'blocked', 'cue-failure', 'device-skip']) test(`announcement chat and voice visibility: ${mode}`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(2026, 8, 15, 12).getTime() });
  t.mock.method(document, 'hasFocus', () => true);
  const originalEventSource = globalThis.EventSource;
  Object.assign(globalThis, { EventSource: class { addEventListener() {} close() {} } });
  t.after(() => Object.assign(globalThis, { EventSource: originalEventSource }));
  let finish!: (response: Response) => void;
  let checks = 0;
  const { getClientId } = await import('../active-client');
  const f = await mount(t, false, async url => {
    if (url === '/api/presence/active-client') return Response.json({ active: { clientId: ++checks > 1 && mode === 'device-skip' ? 'other-device' : getClientId() } });
    if (url.endsWith('/speak')) return new Promise(resolve => finish = resolve);
  }, true);
  await act(async () => {
    t.mock.timers.tick(1);
    __sockets.at(-1).__emit('praxis:event', { type: 'task.failed', eventId: `delivery-${mode}`, taskId: 'task-1', error: 'Build failed', at: new Date().toISOString() });
    await tick(); await tick();
  });
  assert.ok(cortexTestStore.messages.some(m => m.content === 'Fresh spoken response 1.'));
  assert.doesNotMatch(f.host.textContent ?? '', /Fresh spoken response|voice channel/);
  if (mode !== 'device-skip') {
    await act(async () => { finish(mode === 'synthesis-failure' ? Response.json({}, { status: 503 }) : Response.json({ audio: 'synthetic' })); await tick(); });
    assert.doesNotMatch(f.host.textContent ?? '', /Fresh spoken response/);
    if (mode === 'success' || mode === 'blocked') {
      if (mode === 'blocked') t.mock.method(FakeAudio.prototype, 'play', () => Promise.reject(new DOMException('Blocked', 'NotAllowedError')));
      await act(async () => { FakeAudio.all[0].onended?.(); await tick(); await tick(); });
    } else if (mode === 'cue-failure') {
      await act(async () => { FakeAudio.all[0].onerror?.(); await tick(); await tick(); });
    }
  }
  if (mode === 'success') {
    assert.match(f.host.textContent ?? '', /Fresh spoken response/);
    assert.equal(cortexTestStore.messages.filter(m => m.metadata?.voiceDeliveryNotice).length, 0);
  } else {
    assert.doesNotMatch(f.host.textContent ?? '', /Fresh spoken response|voice channel/);
    const notices = cortexTestStore.messages.filter(m => m.metadata?.voiceDeliveryNotice);
    assert.equal(notices.length, 1);
    assert.match(notices[0].content, /Voice update/);
    assert.equal(notices[0].metadata?.suppressVoice, true);
    assert.equal(f.requests.filter(r => r.url.endsWith('/sync') && r.body.messages[0].metadata?.voiceDeliveryNotice).length, 1);
  }
});
