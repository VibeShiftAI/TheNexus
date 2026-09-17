import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceCommandBar } from '../../components/bridge/voice-command-bar';
import { speechOwner } from '../speech-ownership';

const tick = () => new Promise(resolve => setImmediate(resolve));
const preferenceKey = 'nexus.voice.microphone';
class Recorder {
  static isTypeSupported() { return true; }
  static started = 0;
  state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | null = null;
  start() { this.state = 'recording'; Recorder.started++; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}
class TestAudio {
  static all: TestAudio[] = [];
  paused = true; ended = false;
  onended: (() => void) | null = null; onpause: (() => void) | null = null;
  constructor() { TestAudio.all.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.onpause?.(); }
  removeAttribute() {} load() {}
}
async function mount(t: TestContext, options: { deferred?: boolean; error?: string; saved?: string; analyser?: boolean; signal?: number; secure?: boolean; recorder?: boolean; media?: boolean; blockedStorage?: boolean; deferredSpeech?: boolean; concealedDevices?: boolean; savedWake?: boolean; staleEnumeration?: boolean } = {}) {
  localStorage.clear(); Recorder.started = 0; TestAudio.all = [];
  if (options.saved) localStorage.setItem(preferenceKey, options.saved);
  if (options.savedWake) localStorage.setItem('nexus.voice.wakeword', '1');
  const originals = { MediaRecorder: globalThis.MediaRecorder, Audio: globalThis.Audio, AudioContext: window.AudioContext, secure: window.isSecureContext, media: navigator.mediaDevices };
  const requests: { url: string; body: any; signal?: AbortSignal }[] = [];
  const constraints: MediaStreamConstraints[] = [];
  let stops = 0; let resumes = 0; let closes = 0; let grants: ((stream: any) => void)[] = [];
  const stream = () => ({ getTracks: () => [{ stop: () => stops++ }] });
  let devices = options.concealedDevices ? [{ kind: 'audioinput', deviceId: '', label: '' }] : [{ kind: 'audioinput', deviceId: 'desk', label: 'Desk microphone' }];
  let firstEnumeration = true;
  let resolveEnumeration: ((value: typeof devices) => void) | undefined;
  let listeners = 0;
  const deviceEvents = new window.EventTarget();
  const media = {
    getUserMedia: async (value: MediaStreamConstraints) => {
      constraints.push(value);
      if (options.error) throw new DOMException('PRIVATE DEVICE DETAIL', options.error);
      if (options.deferred) return new Promise(resolve => grants.push(resolve));
      return stream();
    },
    enumerateDevices: async () => {
      if (options.staleEnumeration && firstEnumeration) { firstEnumeration = false; return new Promise<typeof devices>(resolve => { resolveEnumeration = resolve; }); }
      return devices;
    },
    addEventListener: (...args: Parameters<typeof deviceEvents.addEventListener>) => { listeners++; deviceEvents.addEventListener(...args); },
    removeEventListener: (...args: Parameters<typeof deviceEvents.removeEventListener>) => { listeners--; deviceEvents.removeEventListener(...args); },
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: options.media === false ? undefined : media });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: options.secure !== false });
  Object.assign(globalThis, { MediaRecorder: options.recorder === false ? undefined : Recorder, Audio: TestAudio });
  Object.assign(window, { AudioContext: options.analyser === false ? undefined : class {
    state = 'suspended';
    resume() { resumes++; this.state = 'running'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData(buf: Float32Array) { buf.fill(options.signal ?? 0.1); } }; }
    close() { closes++; return Promise.resolve(); }
  } });
  if (options.blockedStorage) {
    t.mock.method(Object.getPrototypeOf(localStorage), 'getItem', () => { throw new Error('blocked'); });
    t.mock.method(Object.getPrototypeOf(localStorage), 'setItem', () => { throw new Error('blocked'); });
  }
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = String(input); requests.push({ url, body: init?.body ? JSON.parse(init.body) : null, signal: init?.signal });
    if (url.endsWith('/voice-prose')) return Response.json({ text: 'Fresh audibility test.' });
    if (url.endsWith('/speak')) return options.deferredSpeech ? new Promise<Response>(() => {}) : Response.json({ audio: 'test', mime: 'audio/wav' });
    return url.includes('board') ? Response.json([]) : Response.json({ available: true });
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  t.after(async () => {
    await unmount(); host.remove();
    Object.assign(globalThis, { MediaRecorder: originals.MediaRecorder, Audio: originals.Audio });
    Object.assign(window, { AudioContext: originals.AudioContext });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: originals.secure });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originals.media });
  });
  await act(async () => { root.render(React.createElement(VoiceCommandBar)); await tick(); });
  const click = async (label: string) => {
    const button = host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    assert.ok(button, label); await act(async () => { button.click(); await tick(); });
  };
  const open = async () => { await act(async () => { window.dispatchEvent(new window.Event('nexus:voice-setup')); await tick(); }); };
  const select = async (value: string) => {
    const input = host.querySelector('[aria-label="Microphone input"]') as HTMLSelectElement;
    assert.ok(input, 'Microphone input');
    await act(async () => { input.value = value; input.dispatchEvent(new window.Event('change', { bubbles: true })); await tick(); });
  };
  return { host, click, open, select, constraints, requests, unmount, stops: () => stops, resumes: () => resumes, closes: () => closes, listeners: () => listeners,
    staleEnumeration: async () => { await act(async () => { resolveEnumeration!([]); await tick(); }); },
    grant: async () => { await act(async () => { grants.shift()!(stream()); await tick(); }); },
    devices: async (next: typeof devices) => { devices = next; await act(async () => { deviceEvents.dispatchEvent(new window.Event('devicechange')); await tick(); }); },
  };
}

test('setup event and non-repeating shortcut open and focus setup without capturing', async t => {
  const f = await mount(t); assert.equal(f.constraints.length, 0);
  await f.open(); assert.ok(f.host.querySelector('[aria-label="Microphone input"]'));
  assert.ok(f.host.querySelector('[role="dialog"]')?.contains(document.activeElement));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', altKey: true, shiftKey: true, repeat: true })));
  assert.equal(f.host.querySelector('[role="dialog"]'), null);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', altKey: true, shiftKey: true })));
  assert.ok(f.host.querySelector('[aria-label="Microphone input"]')); assert.equal(f.constraints.length, 0);
});
test('labelled launcher routes to the existing setup without a second capture owner', async t => {
  const module = await import('../../components/voice-launcher').catch(() => null);
  assert.ok(module, 'voice launcher exists');
  const f = await mount(t); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(React.createElement(module.VoiceLauncher)));
  const button = host.querySelector('button'); assert.equal(button?.textContent?.trim(), 'Talk to Praxis');
  await act(async () => { button!.click(); await tick(); });
  assert.ok(f.host.querySelector('[aria-label="Microphone input"]')); assert.equal(f.constraints.length, 0);
});
test('local check uses selected exact input with preferred constraints and stops five seconds after grant', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = await mount(t, { deferred: true }); await f.open(); await f.select('desk'); await f.click('Check microphone');
  assert.match(f.host.textContent ?? '', /Requesting microphone/);
  assert.deepEqual(f.constraints[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'desk' } } });
  await act(async () => { t.mock.timers.tick(10000); await tick(); }); assert.equal(f.stops(), 0);
  await f.grant();
  await act(async () => { t.mock.timers.tick(4999); await tick(); }); assert.equal(f.stops(), 0);
  assert.ok(f.host.querySelector('[role="meter"]')); assert.equal(f.resumes(), 1);
  await act(async () => { t.mock.timers.tick(1); await tick(); }); assert.equal(f.stops(), 1); assert.equal(f.closes(), 1);
  assert.match(f.host.textContent ?? '', /Ready.*signal detected/i); assert.equal(Recorder.started, 0);
  assert.equal(f.requests.some(r => /transcribe|voice-intent|\/chat|\/speak/.test(r.url)), false);
});
for (const cancellation of ['Stop check', 'Escape', 'hidden', 'preemption', 'unmount', 'device change']) {
  test(`pending local check releases a late microphone after ${cancellation}`, async t => {
    const f = await mount(t, { deferred: true }); await f.open(); await f.click('Check microphone');
    if (cancellation === 'Stop check') await f.click('Stop check');
    if (cancellation === 'Escape') await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    if (cancellation === 'hidden') {
      const original = Object.getOwnPropertyDescriptor(document, 'hidden');
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
      if (original) Object.defineProperty(document, 'hidden', original); else Reflect.deleteProperty(document, 'hidden');
    }
    if (cancellation === 'preemption') {
      let lease: ReturnType<typeof speechOwner.claim> = null;
      await act(async () => { lease = speechOwner.claim('test-player', () => {}); }); lease?.release();
    }
    if (cancellation === 'unmount') await f.unmount();
    if (cancellation === 'device change') await f.select('desk');
    await f.grant(); assert.equal(f.stops(), 1); assert.equal(Recorder.started, 0);
    assert.equal(f.requests.some(r => /transcribe|voice-intent|\/chat/.test(r.url)), false);
  });
}
for (const [name, message] of [['NotAllowedError', /site.*microphone.*Windows Settings.*Privacy & security.*Microphone.*desktop.app/i], ['NotFoundError', /reconnect.*default/i], ['OverconstrainedError', /reconnect.*default/i], ['NotReadableError', /another app|other app/i], ['UnexpectedError', /try again/i]] as const) {
  test(`microphone error ${name} gives useful guidance without exception detail`, async t => {
    const f = await mount(t, { error: name }); await f.open(); await f.click('Check microphone');
    assert.match(f.host.textContent ?? '', message); assert.doesNotMatch(f.host.textContent ?? '', /PRIVATE DEVICE DETAIL/);
    await f.click('Start conversation'); assert.match(f.host.textContent ?? '', message);
  });
}
for (const options of [{ secure: false }, { media: false }, { recorder: false }]) {
  test(`unsupported capture keeps visible setup actions and explains recovery ${JSON.stringify(options)}`, async t => {
    const f = await mount(t, options); await f.open();
    assert.ok(f.host.querySelector('[aria-label="Check microphone"]')); assert.ok(f.host.querySelector('[aria-label="Test Praxis voice"]'));
    await f.click('Start conversation'); assert.equal(f.constraints.length, 0); assert.match(f.host.textContent ?? '', /HTTPS|recording.*browser/i);
  });
}
test('raw check can work without MediaRecorder or a permissions query and reports missing meter honestly', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = await mount(t, { recorder: false, analyser: false }); await f.open(); await f.click('Check microphone');
  await act(async () => { t.mock.timers.tick(5000); await tick(); });
  assert.equal(f.stops(), 1); assert.match(f.host.textContent ?? '', /signal meter.*unavailable/i); assert.doesNotMatch(f.host.textContent ?? '', /signal detected|No signal/i);
});
test('silence reports no signal without transcribing', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = await mount(t, { signal: 0 }); await f.open(); await f.click('Check microphone');
  await act(async () => { t.mock.timers.tick(5000); await tick(); });
  assert.match(f.host.textContent ?? '', /No signal/i); assert.equal(f.stops(), 1);
});
test('saved missing device is not silently replaced; choosing default recovers and applies to conversation', async t => {
  const f = await mount(t, { saved: 'missing' }); await f.open();
  assert.match(f.host.textContent ?? '', /reconnect.*default/i);
  await f.click('Check microphone'); assert.equal(f.constraints.length, 0);
  await f.select(''); assert.equal(localStorage.getItem(preferenceKey), '');
  await f.click('Start conversation');
  assert.deepEqual(f.constraints[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  await f.click('End conversation');
});
test('selection persists only per browser and changes cancel capture without rearming it', async t => {
  const f = await mount(t); await f.open(); await f.select('desk'); assert.equal(localStorage.getItem(preferenceKey), 'desk');
  await f.click('Start conversation'); assert.deepEqual((f.constraints[0].audio as MediaTrackConstraints).deviceId, { exact: 'desk' });
  await f.open(); await f.select(''); assert.equal(f.stops(), 1); assert.equal(Recorder.started, 1);
  assert.ok(f.host.querySelector('[aria-label="Start conversation"]'));
});
test('an older enumeration cannot replace refreshed devices or cancel the current check', async t => {
  const f = await mount(t, { staleEnumeration: true }); await f.open(); await f.select('desk'); await f.click('Check microphone');
  await f.staleEnumeration(); assert.equal(f.stops(), 0); assert.doesNotMatch(f.host.textContent ?? '', /not found/i);
  assert.equal(f.listeners(), 1); await f.unmount(); assert.equal(f.listeners(), 0); assert.equal(f.stops(), 1);
});
test('unplugging selected device stops its check and presents reconnect guidance', async t => {
  const f = await mount(t); await f.open(); await f.select('desk'); await f.click('Check microphone');
  await f.devices([]); assert.equal(f.stops(), 1); assert.match(f.host.textContent ?? '', /reconnect.*default/i);
});
test('blocked local storage does not prevent manual setup or microphone check', async t => {
  const f = await mount(t, { blockedStorage: true }); await f.open(); await f.select('desk'); await f.click('Check microphone');
  assert.equal(f.constraints.length, 1); await f.click('Stop check'); assert.equal(f.stops(), 1);
});
test('Test Praxis voice ends conversation, uses shared speech, and Stop speaking cancels the request', async t => {
  const f = await mount(t, { deferredSpeech: true }); await f.click('Start conversation'); await f.open(); await f.click('Test Praxis voice');
  assert.equal(f.stops(), 1); assert.equal(f.constraints.length, 1); assert.ok(f.host.querySelector('[aria-label="Start conversation"]'));
  const request = f.requests.find(r => r.url.endsWith('/speak')); assert.ok(request); assert.equal(typeof request.body.text, 'string');
  await f.click('Stop speaking'); assert.equal(request.signal?.aborted, true); assert.equal(f.constraints.length, 1);
});
test('explicit speech playback preempts local checking without starting follow-up capture', async t => {
  const f = await mount(t); await f.open(); await f.click('Check microphone'); await f.click('Test Praxis voice');
  assert.equal(f.stops(), 1); assert.equal(f.constraints.length, 1); assert.equal(TestAudio.all.length, 1);
  await f.click('Stop speaking'); assert.equal(TestAudio.all[0].paused, true); assert.equal(f.constraints.length, 1);
});
test('a saved wake preference never arms the microphone on mount or opening setup', async t => {
  let starts = 0;
  const previous = (window as any).webkitSpeechRecognition;
  Object.assign(window, { webkitSpeechRecognition: class { start() { starts++; } abort() {} } });
  t.after(() => Object.assign(window, { webkitSpeechRecognition: previous }));
  const f = await mount(t, { savedWake: true }); await f.open();
  assert.equal(starts, 0); assert.equal(f.constraints.length, 0);
});
test('concealed devices before permission do not reject a saved exact microphone', async t => {
  const f = await mount(t, { saved: 'desk', concealedDevices: true, deferred: true }); await f.open();
  assert.doesNotMatch(f.host.textContent ?? '', /not found/i);
  await f.click('Check microphone'); assert.equal(f.constraints.length, 1);
  assert.deepEqual((f.constraints[0].audio as MediaTrackConstraints).deviceId, { exact: 'desk' });
  await f.devices([{ kind: 'audioinput', deviceId: 'desk', label: 'Desk microphone' }]);
  await f.grant(); assert.equal(f.stops(), 0); await f.click('Stop check');
});
for (const cancellation of ['Escape', 'preemption', 'unmount']) {
  test(`active local check stops its stream and timers on ${cancellation}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
    const f = await mount(t); await f.open(); await f.click('Check microphone');
    if (cancellation === 'Escape') await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    if (cancellation === 'unmount') await f.unmount();
    if (cancellation === 'preemption') {
      await act(async () => { const lease = speechOwner.claim('test-player', () => {}); lease?.release(); });
    }
    assert.equal(f.stops(), 1); assert.equal(f.closes(), 1);
    await act(async () => { t.mock.timers.tick(6000); await tick(); });
    assert.equal(f.stops(), 1); assert.doesNotMatch(f.host.textContent ?? '', /signal detected/i);
  });
}

function microphoneTrack(t: TestContext, initiallyEnded = false) {
  let stops = 0; let listenersAtStop = -1;
  class Track extends window.EventTarget {
    readyState = initiallyEnded ? 'ended' : 'live';
    stop() { listenersAtStop = added.mock.callCount() - removed.mock.callCount(); stops++; this.readyState = 'ended'; }
    end(emit = true) { this.readyState = 'ended'; if (emit) this.dispatchEvent(new window.Event('ended')); }
  }
  const track = new Track();
  const added = t.mock.method(track, 'addEventListener'); const removed = t.mock.method(track, 'removeEventListener');
  t.mock.method(navigator.mediaDevices, 'getUserMedia', async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  return { track, stops: () => stops, listenersAtStop: () => listenersAtStop };
}
for (const selected of ['', 'desk']) {
  test(`disconnecting ${selected ? 'selected' : 'default'} microphone after signal reports recovery instead of Ready`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
    const f = await mount(t); const input = microphoneTrack(t); await f.open(); await f.select(selected); await f.click('Check microphone');
    await act(async () => { t.mock.timers.tick(100); await tick(); });
    assert.ok(f.host.querySelector('[role="meter"]'));
    await act(async () => { input.track.end(); await tick(); });
    assert.match(f.host.textContent ?? '', /reconnect.*default/i); assert.equal(input.stops(), 1); assert.equal(input.listenersAtStop(), 0);
    await act(async () => { t.mock.timers.tick(4900); await tick(); });
    assert.doesNotMatch(f.host.textContent ?? '', /Ready.*signal detected/i); assert.equal(input.stops(), 1);
  });
}
test('a track already ended at grant cannot begin a signal check', async t => {
  const f = await mount(t); const input = microphoneTrack(t, true); await f.open(); await f.click('Check microphone');
  assert.match(f.host.textContent ?? '', /reconnect.*default/i); assert.equal(input.stops(), 1); assert.equal(f.resumes(), 0);
});
test('the final check reads track state even when no ended event arrived', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = await mount(t); const input = microphoneTrack(t); await f.open(); await f.click('Check microphone');
  await act(async () => { t.mock.timers.tick(100); await tick(); input.track.end(false); t.mock.timers.tick(4900); await tick(); });
  assert.match(f.host.textContent ?? '', /reconnect.*default/i); assert.doesNotMatch(f.host.textContent ?? '', /Ready.*signal detected/i);
  assert.equal(input.listenersAtStop(), 0);
});
for (const deferredSpeech of [false, true]) {
  test(`missing microphone discovery leaves ${deferredSpeech ? 'pending' : 'playing'} output test owned`, async t => {
    const f = await mount(t, { saved: 'desk', deferredSpeech });
    let finish!: (devices: MediaDeviceInfo[]) => void;
    t.mock.method(navigator.mediaDevices, 'enumerateDevices', () => new Promise(resolve => { finish = resolve; }));
    await f.open(); await f.click('Test Praxis voice');
    const request = f.requests.find(r => r.url.endsWith('/speak')); assert.ok(request);
    await act(async () => { finish([]); await tick(); });
    assert.match(f.host.textContent ?? '', /reconnect.*default/i);
    assert.equal(request.signal?.aborted, false);
    if (!deferredSpeech) assert.equal(TestAudio.all[0].paused, false);
    assert.ok(f.host.querySelector('[aria-label="Stop speaking"]')); assert.equal(f.constraints.length, 0);
    await f.click('Stop speaking'); assert.equal(request.signal?.aborted, true);
  });
}
