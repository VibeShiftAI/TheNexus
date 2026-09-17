import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatAudio, type ChatAudioApi } from '../use-chat-audio';
import { speechOwner, bindMediaSpeech, claimMediaSpeech } from '../../lib/speech-ownership';
import { setActiveClient } from '../../../test/stubs/active-client.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function mockCue(t: any, deferred = false) {
  const original = globalThis.Audio;
  let finish = () => {};
  Object.assign(globalThis, { Audio: class {
    onended: (() => void) | null = null; onerror: (() => void) | null = null;
    volume = 1;
    play() { finish = () => this.onended?.(); if (!deferred) queueMicrotask(finish); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  } });
  t.after(() => Object.assign(globalThis, { Audio: original }));
  return () => finish();
}


test('automatic chat note waits for recording and starts after release', async t => {
  mockCue(t);
  localStorage.clear(); setActiveClient(true);
  const recording = speechOwner.claim('recording', () => {})!;
  let api!: ChatAudioApi; let plays = 0;
  const el = document.createElement('audio'); el.play = async () => { plays++; el.dispatchEvent(new window.Event('play')); }; el.pause = () => el.dispatchEvent(new window.Event('pause'));
  const cleanup = bindMediaSpeech(el);
  const message = { id: 'new-note', role: 'assistant' as const, content: 'reply', timestamp: new Date(), voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }] };
  function Harness() { api = useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => {}, pauseChatAudio: () => {} }); api.voiceAudioRefs.current.set('id:new-note#0', el); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness)); await tick(); }); assert.equal(plays, 0);
  await act(async () => { recording.release(); await tick(); }); assert.equal(plays, 1);
  await act(async () => root.unmount()); cleanup(); setActiveClient(false);
});

test('native chat playback pauses immediately when recording claims speech', () => {
  const el = document.createElement('audio'); let pauses = 0; let paused = false;
  Object.defineProperty(el, 'paused', { get: () => paused });
  el.pause = () => { paused = true; pauses++; el.dispatchEvent(new window.Event('pause')); };
  const cleanup = bindMediaSpeech(el); el.dispatchEvent(new window.Event('play'));
  const recording = speechOwner.claim('recording', () => {})!;
  assert.equal(pauses, 1); assert.equal(recording.owns(), true); cleanup(); recording.release();
});
test('remounting native audio bindings retains ownership of an already playing note', () => {
  const el = document.createElement('audio'); Object.defineProperty(el, 'paused', { value: false });
  el.pause = () => {};
  const first = bindMediaSpeech(el); el.dispatchEvent(new window.Event('play')); first();
  const second = bindMediaSpeech(el); assert.equal(speechOwner.busy(), true); second();
});
test('a note that expires while recording waits stays available for manual replay', async t => {
  localStorage.clear(); setActiveClient(true); t.mock.timers.enable({ apis: ['Date'] });
  const recording = speechOwner.claim('recording', () => {})!; let plays = 0;
  const el = document.createElement('audio'); el.play = async () => { plays++; }; el.pause = () => {};
  const message = { id: 'expiring', role: 'assistant' as const, content: 'reply', timestamp: new Date(), voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }] };
  function Harness() { const api = useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => {}, pauseChatAudio: () => {} }); api.voiceAudioRefs.current.set('id:expiring#0', el); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness)); await tick(); });
  await act(async () => { t.mock.timers.tick(181000); recording.release(); await tick(); });
  assert.equal(plays, 0); await el.play(); assert.equal(plays, 1);
  await act(async () => root.unmount()); setActiveClient(false);
});
test('recording during a deferred active-device lookup invalidates the pending chat start', async () => {
  localStorage.clear(); let finish!: (active: boolean) => void; setActiveClient(() => new Promise(resolve => finish = resolve));
  let plays = 0;
  const el = document.createElement('audio'); el.play = async () => { plays++; }; el.pause = () => {};
  const message = { id: 'pending-note', role: 'assistant' as const, content: 'reply', timestamp: new Date(), voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }] };
  function Harness() { const api = useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => {}, pauseChatAudio: () => {} }); api.voiceAudioRefs.current.set('id:pending-note#0', el); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Harness)); await tick(); });
  const recording = speechOwner.claim('recording', () => {})!;
  await act(async () => { finish(true); await tick(); }); assert.equal(plays, 0); assert.equal(recording.owns(), true);
  await act(async () => root.unmount()); recording.release(); setActiveClient(false);
});

function deferredMediaEvents() {
  const el = document.createElement('audio');
  let paused = true; let ended = false;
  const events: string[] = [];
  Object.defineProperty(el, 'paused', { get: () => paused });
  Object.defineProperty(el, 'ended', { get: () => ended });
  el.play = async () => { paused = false; ended = false; events.push('play'); };
  el.pause = () => { paused = true; events.push('pause'); };
  return { el, events, flush: () => {
    const type = events.shift(); assert.ok(type, 'a deferred media event exists');
    el.dispatchEvent(new window.Event(type));
  }, end: () => { ended = true; events.push('ended'); } };
}

test('a deferred play event from interrupted media cannot cancel recording, while manual replay still can', async t => {
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  let recordingCanceled = 0;
  claimMediaSpeech(media.el); await media.el.play();
  const recording = speechOwner.claim('recording', () => { recordingCanceled++; })!;
  t.after(() => { unbind(); recording.release(); });
  assert.equal(media.el.paused, true); assert.deepEqual(media.events, ['play', 'pause']);
  media.flush();
  assert.equal(recording.owns(), true); assert.equal(recordingCanceled, 0);
  media.flush();
  await media.el.play(); media.flush();
  assert.equal(recording.owns(), false); assert.equal(recordingCanceled, 1);
});

test('a deferred pause from an older playback cannot release a newly started media lease', async t => {
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  t.after(unbind);
  claimMediaSpeech(media.el); await media.el.play(); media.flush();
  media.el.pause();
  const recording = speechOwner.claim('recording', () => {})!;
  // The global player explicitly reserves ownership before invoking play().
  const restarted = claimMediaSpeech(media.el)!; await media.el.play();
  assert.equal(recording.owns(), false); assert.equal(restarted.owns(), true);
  media.flush();
  assert.equal(restarted.owns(), true); assert.equal(media.el.paused, false);
});

test('a deferred play event is also ignored after the media has ended', async t => {
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  t.after(unbind);
  await media.el.play(); media.end(); media.flush();
  assert.equal(speechOwner.busy(), false);
});
test('a deferred ended event cannot release ownership after explicit replay restarts the element', async t => {
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  t.after(unbind);
  claimMediaSpeech(media.el); await media.el.play(); media.flush(); media.end();
  const restarted = claimMediaSpeech(media.el)!; await media.el.play(); media.flush();
  assert.equal(media.el.ended, false); assert.equal(restarted.owns(), true);
});
test('an old queued pause cannot release the actual chat reservation while its comm chirp is pending', async t => {
  localStorage.clear(); setActiveClient(true);
  const finishChirp = mockCue(t, true);
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  claimMediaSpeech(media.el); await media.el.play(); media.flush();
  const recording = speechOwner.claim('recording', () => {})!;
  const message = { id: 'chirp-note', role: 'assistant' as const, content: 'reply', timestamp: new Date(), voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }] };
  function Harness() {
    const api = useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => {}, pauseChatAudio: () => {} });
    api.voiceAudioRefs.current.set('id:chirp-note#0', media.el);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  t.after(async () => { await act(async () => root.unmount()); unbind(); recording.release(); setActiveClient(false); });
  await act(async () => { root.render(React.createElement(Harness)); await tick(); });
  await act(async () => { recording.release(); await tick(); });
  assert.equal(typeof finishChirp, 'function'); assert.equal(media.el.paused, true);
  media.flush(); // Pause from the previous media lease, delivered during the new chirp.
  assert.equal(speechOwner.busy(), true);
  await act(async () => { finishChirp(); await tick(); });
  assert.equal(media.el.paused, false); assert.deepEqual(media.events, ['play']);
});
test('voice-session-owned replies never autoplay in chat but retain manual replay', async t => {
  localStorage.clear(); setActiveClient(true); let plays = 0;
  const el = document.createElement('audio'); el.play = async () => { plays++; }; el.pause = () => {};
  const message = { id: 'voice-owned', role: 'assistant' as const, content: 'reply', timestamp: new Date(), voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }], metadata: { voiceConversation: true, playbackOwner: 'voice' } };
  function Harness() { const api = useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => {}, pauseChatAudio: () => {} }); api.voiceAudioRefs.current.set('id:voice-owned#0', el); return null; }
  const root = createRoot(document.createElement('div'));
  t.after(async () => { await act(async () => root.unmount()); setActiveClient(false); });
  await act(async () => { root.render(React.createElement(Harness)); await tick(); });
  assert.equal(plays, 0); await el.play(); assert.equal(plays, 1);
});

test('suppressed saved audio never autoplays and stays available for explicit replay', async t => {
  localStorage.clear(); setActiveClient(true);
  const media = deferredMediaEvents(); const unbind = bindMediaSpeech(media.el);
  let plays = 0; let reports = 0;
  const play = media.el.play; media.el.play = async () => { plays++; return play(); };
  const base = { role: 'assistant' as const, content: 'Report started.', timestamp: new Date(), metadata: { suppressVoice: true } };
  const messages = [
    { ...base, id: 'suppressed-note', voiceData: [{ audio: 'voice', mimeType: 'audio/wav' }] },
    { ...base, id: 'suppressed-report', attachments: [{ type: 'audio', url: '/report.mp3', kind: 'full_status_report' }] },
  ];
  function Harness() { const api = useChatAudio({ messages, chatAudio: null, playChatAudio: () => { reports++; }, pauseChatAudio: () => {} }); api.voiceAudioRefs.current.set('id:suppressed-note#0', media.el); return null; }
  const host = document.createElement('div'); const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); unbind(); setActiveClient(false); });
  await act(async () => { root.render(React.createElement(Harness)); await tick(); });
  assert.equal(plays, 0); assert.equal(reports, 0);
  await act(async () => { await media.el.play(); media.flush(); });
  assert.equal(plays, 1); assert.equal(speechOwner.busy(), true);
});

test('an unavailable cue leaves a report for manual replay without repeated autoplay attempts', async t => {
  localStorage.clear(); setActiveClient(true);
  const original = globalThis.Audio; let cues = 0; let plays = 0;
  Object.assign(globalThis, { Audio: class {
    onended: (() => void) | null = null; onerror: (() => void) | null = null;
    play() { cues++; return cues === 1 ? Promise.reject(new Error('blocked')) : new Promise(() => {}); }
    pause() {} removeAttribute() {} load() {}
  } });
  const message = { id: 'report-cue-failure', role: 'assistant' as const, content: 'Report ready', timestamp: new Date(), attachments: [{ type: 'audio' as const, url: '/report.mp3', kind: 'full_status_report' as const }] };
  function Harness() { useChatAudio({ messages: [message], chatAudio: null, playChatAudio: () => { plays++; }, pauseChatAudio: () => {} }); return null; }
  const root = createRoot(document.createElement('div'));
  t.after(async () => { await act(async () => root.unmount()); setActiveClient(false); Object.assign(globalThis, { Audio: original }); });
  await act(async () => { root.render(React.createElement(Harness)); await tick(); await tick(); });
  assert.equal(cues, 1); assert.equal(plays, 0); assert.equal(speechOwner.busy(), false);
});
