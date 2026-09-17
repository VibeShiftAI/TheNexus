import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechOwner } from '../speech-ownership';
import { VoiceSpeech, speechChunks, MAX_SPOKEN_CHARS } from '../voice-speech';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
class AudioFake {
  onended: (() => void) | null = null; onpause: (() => void) | null = null; onerror: (() => void) | null = null;
  paused = true; ended = false; src: string;
  constructor(src: string) { this.src = src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.onpause?.(); }
  removeAttribute() { this.src = ''; }
  load() {}
  finishNaturally() { this.paused = true; this.ended = true; this.onpause?.(); this.onended?.(); }
}
function fixture(fetcher: typeof fetch) {
  const owner = new SpeechOwner(); const audios: AudioFake[] = []; const states: string[] = [];
  const speech = new VoiceSpeech({ owner, fetch: fetcher, createAudio: src => { const a = new AudioFake(src); audios.push(a); return a as unknown as HTMLAudioElement; }, onState: state => states.push(state) });
  return { owner, speech, audios, states };
}
test('sentence chunks preserve all characters, including long unpunctuated text', () => {
  const text = 'First sentence. '.repeat(180) + 'x'.repeat(1800) + ' Final thought.';
  const chunks = speechChunks(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(s => s.length <= 1600)); assert.ok(chunks[0].endsWith(' '));
});
test('direct speech interrupts another player; automatic speech waits and stale release cannot clear a new owner', () => {
  const owner = new SpeechOwner(); let paused = false;
  const old = owner.claim('global', () => paused = true)!;
  assert.equal(owner.claim('alert', () => {}, false), null);
  const direct = owner.claim('recording', () => {})!;
  assert.equal(paused, true); old.release(); assert.equal(direct.owns(), true);
  direct.release(); assert.equal(owner.busy(), false);
});
test('cancel aborts pending synthesis and a late response cannot create audio or clear a newer session', async () => {
  const response = deferred<Response>(); let signal: AbortSignal | undefined;
  const f = fixture((async (_url, init) => { signal = init?.signal as AbortSignal; return response.promise; }) as typeof fetch);
  const first = f.speech.begin()!; const pending = f.speech.speak(first, 'Hello.');
  const second = f.speech.begin()!; f.speech.setState(second, 'recording');
  assert.equal(signal?.aborted, true);
  response.resolve(Response.json({ audio: 'old' })); await pending;
  assert.equal(f.audios.length, 0); assert.equal(second.owns(), true); assert.equal(f.states.at(-1), 'recording'); f.speech.cancel();
});
test('complete reply synthesizes and plays chunks sequentially', async () => {
  const texts: string[] = [];
  const f = fixture((async (_url, init) => { texts.push(JSON.parse(String(init?.body)).text); return Response.json({ audio: 'ok', mime: 'audio/wav' }); }) as typeof fetch);
  const text = 'An entire useful sentence. '.repeat(130); const session = f.speech.begin()!;
  const pending = f.speech.speak(session, text); await tick(); assert.equal(texts.length, 1);
  while (session.owns()) { f.audios.at(-1)?.finishNaturally(); await tick(); }
  await pending; assert.equal(texts.join(''), text); assert.equal(f.states.at(-1), 'idle');
});
test('returned voice audio skips synthesis and cancel releases playback', async () => {
  const f = fixture((async () => { throw new Error('must not synthesize'); }) as typeof fetch);
  const session = f.speech.begin()!; const pending = f.speech.speak(session, 'reply', [{ audio: 'provided', mimeType: 'audio/wav' }]); await tick();
  assert.match(f.audios[0].src, /provided/); f.speech.cancel(); await pending;
  assert.equal(f.audios[0].paused, true); assert.equal(f.owner.busy(), false);
});
test('oversized reply produces an explicit limit notice rather than silent truncation', async () => {
  const f = fixture((async () => Response.json({ audio: 'ok' })) as typeof fetch);
  const session = f.speech.begin()!; let notice = '';
  const pending = f.speech.speak(session, 'a'.repeat(MAX_SPOKEN_CHARS + 1), undefined, message => notice = message);
  await tick(); assert.match(notice, /24,000/); assert.match(notice, /full response/i); f.speech.cancel(); await pending;
});
test('playback failure reports incomplete audio and does not synthesize later chunks', async () => {
  let requests = 0; let notice = '';
  const f = fixture((async () => { requests++; return Response.json({ audio: 'ok' }); }) as typeof fetch);
  const session = f.speech.begin()!; const pending = f.speech.speak(session, 'Long reply. '.repeat(300), undefined, message => notice = message);
  await tick(); f.audios[0].onerror?.(); await tick();
  assert.equal(requests, 1); assert.match(notice, /audio playback failure/i); f.speech.cancel(); await pending;
});
test('ownership is rechecked after deferred response JSON decoding', async () => {
  const body = deferred<{ audio: string }>();
  const f = fixture((async () => ({ ok: true, json: () => body.promise })) as unknown as typeof fetch);
  const session = f.speech.begin()!; const pending = f.speech.speak(session, 'Hello.'); await tick(); f.speech.cancel();
  body.resolve({ audio: 'stale' }); await pending; assert.equal(f.audios.length, 0);
});
test('speech reports completion only after the entire reply, and can retain ownership for a follow-up', async () => {
  const f = fixture((async () => Response.json({ audio: 'ok' })) as typeof fetch);
  const session = f.speech.begin()!;
  const pending = f.speech.speak(session, 'reply', [{ audio: 'one', mimeType: 'audio/wav' }, { audio: 'two', mimeType: 'audio/wav' }], undefined, true);
  await tick(); f.audios[0].finishNaturally(); await tick(); assert.equal(f.audios.length, 2); assert.equal(session.owns(), true);
  f.audios[1].finishNaturally(); assert.equal(await pending, 'completed'); assert.equal(session.owns(), true); f.speech.cancel();
});
test('canceled synthesis returns canceled rather than successful completion', async () => {
  const body = deferred<Response>(); const f = fixture((async () => body.promise) as typeof fetch);
  const pending = f.speech.speak(f.speech.begin()!, 'reply'); f.speech.cancel(); body.resolve(Response.json({ audio: 'late' }));
  assert.equal(await pending, 'canceled');
});

test('a real pause before the media ends fails playback and suppresses remaining chunks', async () => {
  const f = fixture((async () => Response.json({ audio: 'ok' })) as typeof fetch);
  const pending = f.speech.speak(f.speech.begin()!, 'reply', [{ audio: 'one', mimeType: 'audio/wav' }, { audio: 'two', mimeType: 'audio/wav' }], undefined, true);
  await tick(); f.audios[0].pause();
  assert.equal(await pending, 'failed'); assert.equal(f.audios.length, 1); assert.equal(f.owner.busy(), false);
});
test('natural pause waits for ended, and intervening explicit playback still cancels the voice turn', async () => {
  const f = fixture((async () => Response.json({ audio: 'ok' })) as typeof fetch);
  const session = f.speech.begin()!; let settled = false;
  const pending = f.speech.speak(session, 'reply', [{ audio: 'one', mimeType: 'audio/wav' }], undefined, true).then(outcome => { settled = true; return outcome; });
  await tick(); const audio = f.audios[0]; const staleEnd = audio.onended;
  audio.paused = true; audio.ended = true; audio.onpause?.(); await tick();
  assert.equal(settled, false); assert.equal(session.owns(), true);
  const other = f.owner.claim('chat', () => {})!; staleEnd?.();
  assert.equal(await pending, 'canceled'); assert.equal(other.owns(), true); other.release();
});

test('announcement cue runs after synthesis, once before the first speech chunk', async () => {
  const cue = deferred<boolean>(); let cues = 0;
  const f = fixture((async () => Response.json({ audio: 'ready' })) as typeof fetch);
  const session = f.speech.begin(true)!;
  const pending = f.speech.speak(session, 'A long update. '.repeat(150), undefined, undefined, false, async () => { cues++; return cue.promise; });
  await tick(); assert.equal(cues, 1); assert.equal(f.audios.length, 0);
  cue.resolve(true); await tick(); assert.equal(f.audios.length, 1);
  while (session.owns()) { f.audios.at(-1)?.finishNaturally(); await tick(); }
  assert.equal(await pending, 'completed'); assert.equal(cues, 1);
});
test('cancel during the cue prevents speech and preserves a new microphone owner', async () => {
  const cue = deferred<boolean>();
  const f = fixture((async () => Response.json({ audio: 'ready' })) as typeof fetch);
  const pending = f.speech.speak(f.speech.begin(true)!, 'Update.', undefined, undefined, false, () => cue.promise);
  await tick(); const recording = f.speech.begin()!; cue.resolve(true);
  assert.equal(await pending, 'canceled'); assert.equal(f.audios.length, 0); assert.equal(recording.owns(), true); f.speech.cancel();
});
test('failed cue keeps the announcement silent and releases ownership', async () => {
  const f = fixture((async () => Response.json({ audio: 'ready' })) as typeof fetch);
  assert.equal(await f.speech.speak(f.speech.begin(true)!, 'Update.', undefined, undefined, false, async () => false), 'canceled');
  assert.equal(f.audios.length, 0); assert.equal(f.owner.busy(), false);
});

for (const status of [401, 403, 429, 503, 504]) test(`speech HTTP ${status} reports a preparation failure, not interrupted playback`, async () => {
  let notice = '';
  const f = fixture((async () => Response.json({ error: 'unavailable' }, { status })) as typeof fetch);
  assert.equal(await f.speech.speak(f.speech.begin()!, 'Reply.', undefined, text => notice = text), 'failed');
  assert.match(notice, new RegExp(String(status)));
  assert.doesNotMatch(notice, /stopped before the reply finished/);
  assert.equal(f.audios.length, 0);
});
test('a sign-in HTML response is distinguished from speech audio', async () => {
  let notice = '';
  const f = fixture((async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch);
  await f.speech.speak(f.speech.begin()!, 'Reply.', undefined, text => notice = text);
  assert.match(notice, /sign.in|web page/i); assert.doesNotMatch(notice, /stopped before/);
});
test('autoplay rejection retains the browser error identity and explains that audio never started', async () => {
  let notice = '';
  const f = fixture((async () => Response.json({ audio: 'ok' })) as typeof fetch);
  const originalPlay = AudioFake.prototype.play;
  AudioFake.prototype.play = () => Promise.reject(new DOMException('gesture required', 'NotAllowedError'));
  try {
    await f.speech.speak(f.speech.begin()!, 'Reply.', undefined, text => notice = text);
    assert.match(notice, /blocked.*playback|playback.*blocked/i);
    assert.match(notice, /NotAllowedError/); assert.doesNotMatch(notice, /stopped before/);
  } finally { AudioFake.prototype.play = originalPlay; }
});
test('network failure before audio exists is reported as a delivery failure', async () => {
  let notice = '';
  const f = fixture((async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
  await f.speech.speak(f.speech.begin()!, 'Reply.', undefined, text => notice = text);
  assert.match(notice, /connection|network/i); assert.doesNotMatch(notice, /stopped before/);
});

for (const cancel of [false, true]) test(`playback callback waits for actual audio start and ignores canceled start: ${cancel}`, async () => {
  const playback = deferred<void>(); let starts = 0;
  const owner = new SpeechOwner(); const audio = new AudioFake('');
  audio.play = () => playback.promise;
  const speech = new VoiceSpeech({ owner, createAudio: () => audio as unknown as HTMLAudioElement, onState: () => {} });
  const pending = speech.speak(speech.begin()!, 'hello', [{ audio: 'provided', mimeType: 'audio/wav' }], undefined, false, undefined, () => starts++);
  await tick(); assert.equal(starts, 0);
  if (cancel) speech.cancel();
  playback.resolve(); await tick();
  assert.equal(starts, cancel ? 0 : 1);
  if (!cancel) audio.finishNaturally();
  assert.equal(await pending, cancel ? 'canceled' : 'completed');
});
